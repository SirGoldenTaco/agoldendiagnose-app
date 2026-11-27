// aGoldenDiagnose helper: the part that talks to Windows.
//
// It WATCHES a game from the outside. It never injects anything into the game, never attaches a debugger and never
// reads the game's memory: it only asks Windows about the process (is it alive, how much CPU / memory / GPU it uses,
// is its window answering, what exit code it ended with). That is the same kind of access Task Manager uses, so
// anti-cheat systems have nothing to object to.
//
// The app (Electron) starts this once and talks to it over stdin / stdout, one JSON object per line.
//   -> {"id":1,"cmd":"procs"}                      <- {"re":1,"ok":true,"list":[...]}
//   <- {"ev":"found",...}  {"ev":"s",...}  {"ev":"exit",...}      (things it reports by itself)
//
// Built with (against the .NET Framework reference, so every call is one Windows really has):
//   mcs -optimize -target:exe -platform:x64 -nostdlib -out:../native/agd-helper.exe AgdHelper.cs  -r:<mono>/4.7.2-api/{mscorlib,System,System.Core,System.Web.Extensions,System.IO.Compression,System.IO.Compression.FileSystem,System.Xml}.dll
//              -r:System.Web.Extensions -r:System.IO.Compression -r:System.IO.Compression.FileSystem -r:System.Xml
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;
using Microsoft.Win32;

static class W {
  public const uint QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000, VM_READ = 0x0010, QUERY_INFO = 0x0400;
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] public static extern bool GetProcessHandleCount(IntPtr h, out uint count);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
  [StructLayout(LayoutKind.Sequential)] public struct PMC { public uint cb; public uint PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage; }
  [DllImport("psapi.dll")] public static extern bool GetProcessMemoryInfo(IntPtr h, out PMC c, uint cb);
  [StructLayout(LayoutKind.Sequential)] public struct MEMSTAT { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
  [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx(ref MEMSTAT m);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PE32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PE32 e);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("psapi.dll")] public static extern bool EnumProcessModulesEx(IntPtr h, [Out] IntPtr[] mods, int cb, out int needed, uint filter);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] public static extern uint GetModuleFileNameExW(IntPtr h, IntPtr mod, StringBuilder name, int size);
}

class Watched {
  public int pid; public IntPtr h; public string name, path; public long startMs;
  public long lastCpu100ns; public long lastWall; public IntPtr hwnd; public long hungSince; public long hungTotal;
}

static class Program {
  static readonly object outLock = new object();
  static readonly JavaScriptSerializer js = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static readonly Dictionary<int, Watched> watched = new Dictionary<int, Watched>();
  static HashSet<string> watchNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static HashSet<string> ignoreNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static bool autoGames = true; static int interval = 2000;
  static readonly HashSet<int> seen = new HashSet<int>();          // pids already looked at (reported or not a game)
  static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  static long Now() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }
  static long ToMs(DateTime utc) { return (long)(utc - Epoch).TotalMilliseconds; }

  static void Send(Dictionary<string, object> o) { string s = js.Serialize(o); lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  static Dictionary<string, object> D(params object[] kv) { var d = new Dictionary<string, object>(); for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1]; return d; }

  // ------------------------------------------------------------------ processes
  // Where game launchers keep their games: a program started from one of these is treated as a game.
  static readonly string[] LIBS = { "\\steamapps\\common\\", "\\epic games\\", "\\gog galaxy\\games\\", "\\gog games\\", "\\xboxgames\\", "\\riot games\\", "\\ubisoft game launcher\\games\\", "\\ea games\\", "\\origin games\\", "\\rockstar games\\", "\\itch\\apps\\", "\\battle.net games\\", "\\amazon games\\library\\", "\\games\\" };
  // Helpers that live in those folders but are not the game itself.
  static readonly string[] NOT_GAMES = { "crash", "report", "launcher", "anticheat", "easyanticheat", "beservice", "battleye", "webhelper", "cefprocess", "cefsubprocess", "qtwebengine", "redist", "vc_redist", "dxsetup", "dotnet", "installer", "uninstall", "unins", "setup", "overlay", "updater", "update", "helper", "bootstrap", "prereq", "socialclub", "steamservice", "steamerrorreporter", "epicwebhelper", "ucsvc", "upc.exe", "gamebar", "touchup", "cleanup", "config", "diagnos", "benchmark", "server", "editor", "sdk", "activation", "language", "subprocess", "nvngx", "amd", "dlss", "vrserver", "vrmonitor", "vrcompositor", "vrdashboard", "vrwebhelper", "steamvr", "wallpaper" };

  static string PathOf(int pid) {
    IntPtr h = W.OpenProcess(W.QUERY_LIMITED, false, pid); if (h == IntPtr.Zero) return "";
    try { var sb = new StringBuilder(1024); int n = sb.Capacity; return W.QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; } finally { W.CloseHandle(h); }
  }
  static List<W.PE32> Snapshot() {
    var list = new List<W.PE32>(); IntPtr s = W.CreateToolhelp32Snapshot(2, 0); if (s == IntPtr.Zero || s == new IntPtr(-1)) return list;
    try { var e = new W.PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(W.PE32)); if (W.Process32FirstW(s, ref e)) do { list.Add(e); } while (W.Process32NextW(s, ref e)); } finally { W.CloseHandle(s); }
    return list;
  }
  static Dictionary<int, KeyValuePair<IntPtr, string>> Windows() {       // pid -> its main visible window and title
    var map = new Dictionary<int, KeyValuePair<IntPtr, string>>();
    W.EnumWindows((hwnd, l) => {
      if (!W.IsWindowVisible(hwnd) || W.GetWindow(hwnd, 4) != IntPtr.Zero) return true;
      uint pid; W.GetWindowThreadProcessId(hwnd, out pid);
      var sb = new StringBuilder(300); W.GetWindowTextW(hwnd, sb, 300);
      string t = sb.ToString(); if (t.Length == 0) return true;
      if (!map.ContainsKey((int)pid)) map[(int)pid] = new KeyValuePair<IntPtr, string>(hwnd, t);
      return true;
    }, IntPtr.Zero);
    return map;
  }
  static bool LooksLikeGame(string path, string name) {
    string p = path.ToLowerInvariant(), n = name.ToLowerInvariant();
    if (p.Length == 0 || p.Contains("\\windows\\") || p.Contains("\\program files\\windowsapps\\microsoft.")) return false;
    foreach (string bad in NOT_GAMES) if (n.Contains(bad)) return false;
    foreach (string m in LIBS) if (p.Contains(m)) return true;
    return EngineFolder(path, n);
  }
  // A game installed anywhere else (its own folder, another drive, a repack) is recognised by what sits next to it:
  // the files game engines and game stores always ship. Looked up once per folder.
  static readonly Dictionary<string, bool> engineDirs = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
  static readonly string[] ENGINE_FILES = { "UnityPlayer.dll", "GameAssembly.dll", "UnityCrashHandler64.exe", "steam_api64.dll", "steam_api.dll", "steam_appid.txt", "EOSSDK-Win64-Shipping.dll", "Galaxy64.dll", "Galaxy.dll", "GFSDK_Aftermath_Lib.x64.dll", "fmod.dll", "fmodstudio.dll", "bink2w64.dll", "PhysX3_x64.dll", "nvngx_dlss.dll", "amd_fidelityfx_dx12.dll", "libScePad.dll", "oo2core_9_win64.dll", "D3D12Core.dll", "libGodot.dll", "data.win", "nw.pak" };
  static bool EngineFolder(string path, string nameLower) {
    string dir; try { dir = Path.GetDirectoryName(path) ?? ""; } catch { return false; }
    if (dir.Length == 0) return false;
    string d = dir.ToLowerInvariant();
    if (d.Contains("\\appdata\\") || d.Contains("\\program files\\windowsapps\\") || d.Contains("\\programdata\\") || d.Contains("\\common files\\") || d.Contains("\\microsoft\\")) return false;      // apps and their helpers live there, games don't
    bool yes;
    lock (engineDirs) if (engineDirs.TryGetValue(dir, out yes)) return yes;
    yes = nameLower.Contains("-win64-shipping") || nameLower.Contains("-wingdk-shipping") || d.EndsWith("\\binaries\\win64") || d.EndsWith("\\binaries\\wingdk");       // Unreal Engine
    try {
      if (!yes) foreach (string f in ENGINE_FILES) if (File.Exists(Path.Combine(dir, f))) { yes = true; break; }
      if (!yes) yes = Directory.Exists(Path.Combine(dir, Path.GetFileNameWithoutExtension(path) + "_Data"));                 // Unity
      if (!yes) yes = Directory.Exists(Path.Combine(dir, "Engine", "Binaries")) || Directory.GetFiles(dir, "*.pck").Length > 0 || Directory.GetFiles(dir, "*.rpa").Length > 0;      // Unreal's small starter next to Engine\, Godot, Ren'Py
    } catch { }
    lock (engineDirs) engineDirs[dir] = yes;
    return yes;
  }
  static readonly Dictionary<int, int> noPath = new Dictionary<int, int>();       // pid -> times its path couldn't be read yet

  static object Procs(bool all) {
    var wins = Windows(); var list = new List<object>(); int me = Process.GetCurrentProcess().Id;
    foreach (var e in Snapshot()) {
      int pid = (int)e.th32ProcessID; if (pid <= 4 || pid == me) continue;
      bool hasWin = wins.ContainsKey(pid);
      if (!all && !hasWin) continue;
      string path = all && !hasWin ? "" : PathOf(pid);
      if (!all && (path.Length == 0 || path.ToLowerInvariant().Contains("\\windows\\"))) continue;
      list.Add(D("pid", pid, "name", e.szExeFile, "path", path, "title", hasWin ? wins[pid].Value : "", "threads", (int)e.cntThreads, "game", path.Length > 0 && LooksLikeGame(path, e.szExeFile), "watched", watched.ContainsKey(pid)));
    }
    return list;
  }

  static bool Attach(int pid, string why) {
    lock (watched) {
      if (watched.ContainsKey(pid)) return true;
      IntPtr h = W.OpenProcess(W.QUERY_LIMITED | W.SYNCHRONIZE, false, pid);
      if (h == IntPtr.Zero) return false;
      var sb = new StringBuilder(1024); int n = sb.Capacity; string path = W.QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
      long c, x, k, u; long start = Now(); if (W.GetProcessTimes(h, out c, out x, out k, out u)) { try { start = ToMs(DateTime.FromFileTimeUtc(c)); } catch { } W.GetProcessTimes(h, out c, out x, out k, out u); }
      var w = new Watched { pid = pid, h = h, path = path, name = Path.GetFileName(path), startMs = start, lastCpu100ns = k + u, lastWall = Now() };
      watched[pid] = w;
      var wins = Windows();
      Send(D("ev", "found", "pid", pid, "name", w.name, "path", path, "startMs", start, "title", wins.ContainsKey(pid) ? wins[pid].Value : "", "why", why));
      return true;
    }
  }
  static void Detach(int pid) { lock (watched) { Watched w; if (watched.TryGetValue(pid, out w)) { W.CloseHandle(w.h); watched.Remove(pid); } } }

  // ------------------------------------------------------------------ GPU (the same counters Task Manager shows)
  static readonly Dictionary<string, PerformanceCounter> gpuEng = new Dictionary<string, PerformanceCounter>();
  static readonly Dictionary<string, PerformanceCounter> gpuMem = new Dictionary<string, PerformanceCounter>();
  static readonly Dictionary<string, PerformanceCounter> gpuAda = new Dictionary<string, PerformanceCounter>();
  static int gpuTick = 0; static bool gpuOk = true;
  static void SyncCounters(string cat, string counter, Dictionary<string, PerformanceCounter> map, Func<string, bool> keep) {
    string[] names; try { names = new PerformanceCounterCategory(cat).GetInstanceNames(); } catch { return; }
    var want = new HashSet<string>(names.Where(keep));
    foreach (string old in map.Keys.Where(k => !want.Contains(k)).ToList()) { try { map[old].Dispose(); } catch { } map.Remove(old); }
    foreach (string n in want) if (!map.ContainsKey(n)) { try { var pc = new PerformanceCounter(cat, counter, n, true); pc.NextValue(); map[n] = pc; } catch { } }
  }
  static void GpuRefresh() {
    if (!gpuOk) return;
    try {
      SyncCounters("GPU Engine", "Utilization Percentage", gpuEng, n => n.Contains("engtype_3D") || n.Contains("engtype_Compute") || n.Contains("engtype_VideoDecode"));
      SyncCounters("GPU Process Memory", "Dedicated Usage", gpuMem, n => true);
      SyncCounters("GPU Adapter Memory", "Dedicated Usage", gpuAda, n => true);
    } catch { gpuOk = false; }
  }
  static double GpuUse(int pid) {      // pid < 0: the whole PC
    double sum = 0; string key = "pid_" + pid + "_";
    foreach (var kv in gpuEng) { if (!kv.Key.Contains("engtype_3D")) continue; if (pid >= 0 && !kv.Key.StartsWith(key)) continue; try { sum += kv.Value.NextValue(); } catch { } }
    return Math.Min(100, Math.Round(sum, 1));
  }
  static double GpuMemMB(int pid) {
    double sum = 0; string key = "pid_" + pid + "_";
    foreach (var kv in (pid >= 0 ? gpuMem : gpuAda)) { if (pid >= 0 && !kv.Key.StartsWith(key)) continue; try { sum += kv.Value.NextValue(); } catch { } }
    return Math.Round(sum / 1048576.0);
  }
  // NVIDIA cards: temperature and power, from the driver's own tool
  static int smiFails = 0; static double gpuTemp = -1, gpuPower = -1; static string smiPath = null;
  static double smiUse = -1, smiMem = -1, smiMemTotal = -1, smiFan = -1; static string smiName = "";      // also from the driver's tool: how busy the card is, its video memory, its fan, its name
  static void Smi() {
    if (smiFails > 2) return;
    try {
      if (smiPath == null) { smiPath = Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe"); if (!File.Exists(smiPath)) { smiFails = 99; return; } }
      var psi = new ProcessStartInfo(smiPath, "--query-gpu=temperature.gpu,power.draw,utilization.gpu,memory.used,memory.total,fan.speed,name --format=csv,noheader,nounits") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
      using (var p = Process.Start(psi)) {
        if (!p.WaitForExit(1500)) { try { p.Kill(); } catch { } smiFails++; return; }
        string[] f = (p.StandardOutput.ReadLine() ?? "").Split(',');
        double t, w; if (f.Length >= 1 && double.TryParse(f[0].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out t)) gpuTemp = t;
        if (f.Length >= 2 && double.TryParse(f[1].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out w)) gpuPower = Math.Round(w);
        Func<int, double> num = (i) => { double v; return f.Length > i && double.TryParse(f[i].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : -1; };
        smiUse = num(2); smiMem = num(3); smiMemTotal = num(4); smiFan = num(5); if (f.Length > 6) smiName = f[6].Trim();
        smiFails = 0;
      }
    } catch { smiFails++; }
  }

  // ------------------------------------------------------------------ the sampler: one pass every `interval`
  static PerformanceCounter cpuAll;
  static void Tick() {
    long now = Now();
    // new games
    if (autoGames || watchNames.Count > 0) {
      var alive = new HashSet<int>();
      foreach (var e in Snapshot()) {
        int pid = (int)e.th32ProcessID; alive.Add(pid);
        if (pid <= 4 || seen.Contains(pid)) continue;
        string name = e.szExeFile ?? "";
        if (ignoreNames.Contains(name)) { seen.Add(pid); continue; }
        bool named = watchNames.Contains(name);
        if (!named && !autoGames) { seen.Add(pid); continue; }
        if (!named) {
          string p = PathOf(pid);
          if (p.Length == 0) { int tries; noPath.TryGetValue(pid, out tries); if (tries < 5) { noPath[pid] = tries + 1; continue; } }      // just started, or not readable yet: look again on the next passes
          noPath.Remove(pid);
          if (!LooksLikeGame(p, name)) { seen.Add(pid); continue; }
        }
        seen.Add(pid); Attach(pid, named ? "listed" : "library");
      }
      seen.RemoveWhere(p => !alive.Contains(p));
    }
    List<Watched> list; lock (watched) list = watched.Values.ToList();
    if (list.Count == 0) return;
    if (gpuTick++ % 5 == 0) GpuRefresh();
    if (gpuTick % 3 == 1) Smi();
    double sysCpu = -1; try { if (cpuAll == null) { cpuAll = new PerformanceCounter("Processor", "% Processor Time", "_Total", true); cpuAll.NextValue(); } else sysCpu = Math.Round(cpuAll.NextValue(), 1); } catch { }
    var ms = new W.MEMSTAT(); ms.dwLength = (uint)Marshal.SizeOf(typeof(W.MEMSTAT)); W.GlobalMemoryStatusEx(ref ms);
    double sysGpu = GpuUse(-1), sysVram = GpuMemMB(-1);
    var wins = Windows();
    foreach (var w in list) {
      if (W.WaitForSingleObject(w.h, 0) == 0) {          // it ended
        uint code; W.GetExitCodeProcess(w.h, out code);
        long c, x, k, u; long endMs = now; if (W.GetProcessTimes(w.h, out c, out x, out k, out u) && x > 0) { try { endMs = ToMs(DateTime.FromFileTimeUtc(x)); } catch { } }
        Send(D("ev", "exit", "pid", w.pid, "code", (long)code, "t", endMs, "hungMs", w.hungSince > 0 ? now - w.hungSince : 0, "hungTotalMs", w.hungTotal));
        Detach(w.pid); continue;
      }
      var o = D("ev", "s", "pid", w.pid, "t", now);
      long c2, x2, k2, u2;
      if (W.GetProcessTimes(w.h, out c2, out x2, out k2, out u2)) { long cpu = k2 + u2; double dt = Math.Max(1, now - w.lastWall) * 10000.0; o["cpu"] = Math.Round(Math.Min(100.0, (cpu - w.lastCpu100ns) / dt / Environment.ProcessorCount * 100.0), 1); w.lastCpu100ns = cpu; w.lastWall = now; }
      W.PMC pmc; if (W.GetProcessMemoryInfo(w.h, out pmc, (uint)Marshal.SizeOf(typeof(W.PMC)))) { o["ws"] = Math.Round((double)pmc.WorkingSetSize.ToUInt64() / 1048576.0); o["pm"] = Math.Round((double)pmc.PrivateUsage.ToUInt64() / 1048576.0); }
      uint hc; if (W.GetProcessHandleCount(w.h, out hc)) o["hnd"] = (int)hc;
      o["gpu"] = GpuUse(w.pid); o["vram"] = GpuMemMB(w.pid);
      bool hung = false;
      if (wins.ContainsKey(w.pid)) { w.hwnd = wins[w.pid].Key; o["title"] = wins[w.pid].Value; try { hung = W.IsHungAppWindow(w.hwnd); } catch { } }
      if (hung) { if (w.hungSince == 0) w.hungSince = now; w.hungTotal += interval; } else w.hungSince = 0;
      o["hung"] = hung ? now - w.hungSince + interval : 0;
      o["sc"] = sysCpu; o["sm"] = (int)ms.dwMemoryLoad; o["ramFree"] = Math.Round(ms.ullAvailPhys / 1048576.0);
      o["commit"] = ms.ullTotalPageFile > 0 ? Math.Round(100.0 - ms.ullAvailPageFile * 100.0 / ms.ullTotalPageFile, 1) : -1;
      o["sg"] = sysGpu; o["sv"] = sysVram; o["gt"] = gpuTemp; o["gp"] = gpuPower;
      Send(o);
    }
  }

  // ------------------------------------------------------------------ Windows event log (what Windows wrote down about the crash)
  static string Run(string exe, string args, int timeoutMs) {
    try {
      var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
      using (var p = Process.Start(psi)) {
        var sb = new StringBuilder(); p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); }; p.BeginOutputReadLine(); p.BeginErrorReadLine();
        if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } }
        p.WaitForExit(500); lock (sb) return sb.ToString();
      }
    } catch { return ""; }
  }
  static readonly string[] APP_PROVIDERS = { "Application Error", "Application Hang", "Windows Error Reporting", ".NET Runtime", "SideBySide", "Application Popup", "ESENT" };
  static readonly string[] SYS_PROVIDERS = { "Display", "nvlddmkm", "amdkmdag", "amdwddmg", "igfx", "Microsoft-Windows-WHEA-Logger", "Microsoft-Windows-Kernel-Power", "Microsoft-Windows-Resource-Exhaustion-Detector", "BugCheck", "Microsoft-Windows-WER-SystemErrorReporting", "volmgr", "disk", "Ntfs", "Microsoft-Windows-Kernel-Processor-Power", "Application Popup", "Microsoft-Windows-DxgKrnl", "EventLog", "Microsoft-Windows-Kernel-Boot", "nvme", "stornvme", "Microsoft-Windows-Kernel-PnP" };
  static List<object> Events(long fromMs, long toMs) {
    var outp = new List<object>();
    foreach (string log in new[] { "Application", "System" }) {
      string f = Epoch.AddMilliseconds(fromMs).ToString("yyyy-MM-ddTHH:mm:ss.000Z"), t = Epoch.AddMilliseconds(toMs).ToString("yyyy-MM-ddTHH:mm:ss.999Z");
      string[] provs = log == "Application" ? APP_PROVIDERS : SYS_PROVIDERS;
      string q = "*[System[(" + string.Join(" or ", provs.Select(p => "Provider[@Name='" + p + "']")) + ") and TimeCreated[@SystemTime>='" + f + "' and @SystemTime<='" + t + "']]]";
      string xml = Run(Path.Combine(Environment.SystemDirectory, "wevtutil.exe"), "qe " + log + " /q:\"" + q + "\" /f:RenderedXml /c:120 /rd:true /e:Events", 12000);
      if (xml.IndexOf("<Event", StringComparison.Ordinal) < 0) continue;
      try {
        var doc = new XmlDocument(); doc.LoadXml(xml);
        foreach (XmlNode ev in doc.DocumentElement.ChildNodes) {
          if (ev.LocalName != "Event") continue;
          XmlNode sys = Child(ev, "System"); if (sys == null) continue;
          XmlNode prov = Child(sys, "Provider"), tc = Child(sys, "TimeCreated"), idn = Child(sys, "EventID"), lvl = Child(sys, "Level");
          var data = new List<string>(); XmlNode ed = Child(ev, "EventData") ?? Child(ev, "UserData");
          if (ed != null) foreach (XmlNode dn in ed.ChildNodes) { if (dn.ChildNodes.Count > 1 || (dn.FirstChild != null && dn.FirstChild.NodeType == XmlNodeType.Element)) foreach (XmlNode dd in dn.ChildNodes) data.Add(Clip(dd.InnerText, 600)); else data.Add(Clip(dn.InnerText, 600)); }
          string msg = ""; XmlNode ri = Child(ev, "RenderingInfo"); if (ri != null) { XmlNode m = Child(ri, "Message"); if (m != null) msg = Clip(m.InnerText, 2500); }
          long when = 0; DateTime dt; if (tc != null && tc.Attributes["SystemTime"] != null && DateTime.TryParse(tc.Attributes["SystemTime"].Value, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out dt)) when = ToMs(dt);
          int id = 0; if (idn != null) int.TryParse(idn.InnerText, out id); int level = 4; if (lvl != null) int.TryParse(lvl.InnerText, out level);
          outp.Add(D("log", log, "provider", prov != null && prov.Attributes["Name"] != null ? prov.Attributes["Name"].Value : "", "id", id, "level", level, "t", when, "message", msg, "data", data));
        }
      } catch { }
    }
    return outp;
  }
  static XmlNode Child(XmlNode n, string local) { foreach (XmlNode c in n.ChildNodes) if (c.LocalName == local) return c; return null; }
  static string Clip(string s, int max) { if (s == null) return ""; return s.Length > max ? s.Substring(0, max) + "…" : s; }

  // ------------------------------------------------------------------ files the game (or Windows) wrote during the session
  static readonly HashSet<string> LOG_EXT = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".log", ".txt", ".dmp", ".mdmp", ".hdmp", ".crash", ".rpt", ".wer", ".err", ".out", ".trace", ".xml", ".json", ".ips", ".stacktrace", ".runtimexml", ".runtime-xml" };
  static readonly string[] LOG_WORDS = { "log", "crash", "error", "dump", "report", "trace", "output", "player", "exception", "debug", "stderr", "stdout", "diagnos", "fatal" };
  static readonly string[] SKIP_DIRS = { "node_modules", "\\cache", "shadercache", "shader_cache", "pipelinecaches", "\\webcache", "\\gpucache", "code cache", "\\temp\\", "\\assets", "\\content\\paks", "\\movies", "\\__pycache__", "\\.git", "\\workshop\\", "\\screenshots", "\\replays", "\\savegames", "\\saves\\" };
  static void ScanDir(string dir, int depth, int maxDepth, long fromMs, long toMs, string[] tokens, bool needToken, string kind, List<object> found, Stopwatch sw, int budgetMs, ref int dirs) {
    if (found.Count >= 400 || sw.ElapsedMilliseconds > budgetMs || dirs > 60000) return;
    dirs++;
    string low = dir.ToLowerInvariant() + "\\";
    bool inToken = !needToken || tokens.Any(t => low.Contains(t));
    try {
      foreach (string f in Directory.GetFiles(dir)) {
        string ext = Path.GetExtension(f); if (!LOG_EXT.Contains(ext)) continue;
        string nameLow = Path.GetFileName(f).ToLowerInvariant();
        bool dumpy = ext.Equals(".dmp", StringComparison.OrdinalIgnoreCase) || ext.Equals(".mdmp", StringComparison.OrdinalIgnoreCase) || ext.Equals(".hdmp", StringComparison.OrdinalIgnoreCase) || ext.Equals(".wer", StringComparison.OrdinalIgnoreCase) || ext.Equals(".crash", StringComparison.OrdinalIgnoreCase);
        if (!inToken && !tokens.Any(t => nameLow.Contains(t))) continue;
        if (!dumpy && !ext.Equals(".log", StringComparison.OrdinalIgnoreCase) && !LOG_WORDS.Any(wd => nameLow.Contains(wd) || low.Contains("\\" + wd)) ) continue;
        FileInfo fi; try { fi = new FileInfo(f); } catch { continue; }
        long m = ToMs(fi.LastWriteTimeUtc); if (m < fromMs || m > toMs) continue;
        if (fi.Length == 0) continue;
        found.Add(D("path", f, "size", fi.Length, "mtime", m, "kind", dumpy ? (kind == "game" ? "game-dump" : "dump") : kind == "game" ? "game-log" : "log"));
        if (found.Count >= 400) return;
      }
      if (depth >= maxDepth) return;
      foreach (string sub in Directory.GetDirectories(dir)) {
        string sl = sub.ToLowerInvariant();
        if (SKIP_DIRS.Any(s => (sl + "\\").Contains(s))) continue;
        try { if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0) continue; } catch { continue; }
        ScanDir(sub, depth + 1, maxDepth, fromMs, toMs, tokens, needToken, kind, found, sw, budgetMs, ref dirs);
      }
    } catch { }
  }
  /// roots: [{path, depth, needToken, kind}]  tokens: lower-case words that tie a folder or file to this game
  static object Scan(object[] roots, string[] tokens, long fromMs, long toMs) {
    var found = new List<object>(); var sw = Stopwatch.StartNew(); int dirs = 0;
    foreach (object r in roots) {
      var d = r as Dictionary<string, object>; if (d == null) continue;
      string path = Environment.ExpandEnvironmentVariables(Convert.ToString(d["path"])); if (!Directory.Exists(path)) continue;
      ScanDir(path.TrimEnd('\\'), 0, Convert.ToInt32(d["depth"]), fromMs, toMs, tokens, Convert.ToBoolean(d["needToken"]), Convert.ToString(d["kind"]), found, sw, 20000, ref dirs);
    }
    return D("files", found, "dirs", dirs, "ms", sw.ElapsedMilliseconds);
  }
  /// Copies the found files into the report's folder. Text files over tailBytes keep their beginning and their end.
  static object CopyFiles(object[] files, string dest, long maxBytes, long tailBytes) {
    Directory.CreateDirectory(dest); var done = new List<object>(); var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (object fo in files) {
      var d = fo as Dictionary<string, object>; if (d == null) continue;
      string src = Convert.ToString(d["path"]), name = Path.GetFileName(src);
      try {
        var fi = new FileInfo(src); if (!fi.Exists) continue;
        string ext = fi.Extension.ToLowerInvariant(); bool binary = ext == ".dmp" || ext == ".mdmp" || ext == ".hdmp";
        if (binary && fi.Length > maxBytes) { done.Add(D("orig", src, "name", "", "size", fi.Length, "skipped", "too big to copy (" + (fi.Length / 1048576) + " MB): left where it is")); continue; }
        string target = name; int i = 2; while (used.Contains(target)) target = Path.GetFileNameWithoutExtension(name) + " (" + (i++) + ")" + Path.GetExtension(name);
        used.Add(target); string full = Path.Combine(dest, target); bool cut = false;
        using (var inp = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var outp = new FileStream(full, FileMode.Create, FileAccess.Write)) {
          if (!binary && fi.Length > tailBytes) {
            cut = true; long head = Math.Min(200000, tailBytes / 5);
            Pump(inp, outp, head);
            byte[] note = Encoding.UTF8.GetBytes("\r\n\r\n[... aGoldenDiagnose left out the middle of this file (" + ((fi.Length - tailBytes) / 1024) + " KB) ...]\r\n\r\n"); outp.Write(note, 0, note.Length);
            inp.Seek(-(tailBytes - head), SeekOrigin.End); Pump(inp, outp, tailBytes - head);
          } else Pump(inp, outp, long.MaxValue);
        }
        try { File.SetLastWriteTimeUtc(full, fi.LastWriteTimeUtc); } catch { }
        done.Add(D("orig", src, "name", target, "size", fi.Length, "mtime", ToMs(fi.LastWriteTimeUtc), "cut", cut, "kind", d.ContainsKey("kind") ? d["kind"] : "log"));
      } catch (Exception e) { done.Add(D("orig", src, "name", "", "size", 0, "skipped", "couldn't be read: " + e.Message)); }
    }
    return done;
  }
  static void Pump(Stream a, Stream b, long max) { var buf = new byte[81920]; long left = max; int n; while (left > 0 && (n = a.Read(buf, 0, (int)Math.Min(buf.Length, left))) > 0) { b.Write(buf, 0, n); left -= n; } }

  // ------------------------------------------------------------------ crash dumps: what kind of error, and inside which file
  public static Dictionary<string, object> Dump(string path) {
    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
    using (var br = new BinaryReader(fs)) {
      if (fs.Length < 32 || br.ReadUInt32() != 0x504D444D) return D("ok", false, "error", "not a Windows crash dump");
      br.ReadUInt32(); uint count = br.ReadUInt32(), dirRva = br.ReadUInt32();
      ulong exAddr = 0; uint exCode = 0; bool hasEx = false; uint modRva = 0; var prm = new List<string>();
      for (uint i = 0; i < count && i < 200; i++) {
        fs.Position = dirRva + i * 12; uint type = br.ReadUInt32(); br.ReadUInt32(); uint rva = br.ReadUInt32();
        if (type == 6) { fs.Position = rva + 8; exCode = br.ReadUInt32(); br.ReadUInt32(); br.ReadUInt64(); exAddr = br.ReadUInt64(); uint np = br.ReadUInt32(); br.ReadUInt32(); for (uint k = 0; k < np && k < 4; k++) prm.Add("0x" + br.ReadUInt64().ToString("X")); hasEx = true; }
        else if (type == 4) modRva = rva;
      }
      string module = "", modulePath = ""; ulong offset = 0; var mods = new List<string>();
      if (modRva != 0) {
        fs.Position = modRva; uint n = br.ReadUInt32();
        for (uint i = 0; i < n && i < 2000; i++) {
          fs.Position = modRva + 4 + i * 108; ulong b = br.ReadUInt64(); uint size = br.ReadUInt32(); br.ReadUInt32(); br.ReadUInt32(); uint nameRva = br.ReadUInt32();
          long keep = fs.Position; fs.Position = nameRva; uint len = br.ReadUInt32(); string name = len > 0 && len < 4000 ? Encoding.Unicode.GetString(br.ReadBytes((int)len)) : ""; fs.Position = keep;
          mods.Add(Leaf(name));
          if (hasEx && exAddr >= b && exAddr < b + size) { modulePath = name; module = Leaf(name); offset = exAddr - b; }
        }
      }
      return D("ok", true, "hasException", hasEx, "code", (long)exCode, "codeHex", "0x" + exCode.ToString("X8"), "address", "0x" + exAddr.ToString("X"), "module", module, "modulePath", modulePath, "offset", "0x" + offset.ToString("X"), "params", prm, "modules", mods, "size", fs.Length);
    }
  }

  static string Leaf(string p) { int i = Math.Max(p.LastIndexOf('\\'), p.LastIndexOf('/')); return i >= 0 ? p.Substring(i + 1) : p; }

  // ------------------------------------------------------------------ the PC
  static object Reg(RegistryKey root, string path, string name) { try { using (var k = root.OpenSubKey(path)) return k == null ? null : k.GetValue(name); } catch { return null; } }
  static object SysInfo() {
    var ms = new W.MEMSTAT(); ms.dwLength = (uint)Marshal.SizeOf(typeof(W.MEMSTAT)); W.GlobalMemoryStatusEx(ref ms);
    var gpus = new List<object>();
    try {
      using (var cls = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}")) {
        if (cls != null) foreach (string sub in cls.GetSubKeyNames()) {
          if (sub.Length != 4) continue;
          try { using (var k = cls.OpenSubKey(sub)) {
            string desc = Convert.ToString(k.GetValue("DriverDesc") ?? ""); if (desc.Length == 0) continue;
            object q = k.GetValue("HardwareInformation.qwMemorySize"); double vram = 0; try { if (q != null) vram = Math.Round(Convert.ToDouble(q) / 1048576.0); } catch { }
            gpus.Add(D("name", desc, "driver", Convert.ToString(k.GetValue("DriverVersion") ?? ""), "driverDate", Convert.ToString(k.GetValue("DriverDate") ?? ""), "vramMB", vram, "provider", Convert.ToString(k.GetValue("ProviderName") ?? "")));
          } } catch { }
        }
      }
    } catch { }
    var disks = new List<object>();
    try { foreach (var d in DriveInfo.GetDrives()) { if (d.DriveType != DriveType.Fixed || !d.IsReady) continue; disks.Add(D("name", d.Name, "freeGB", Math.Round(d.AvailableFreeSpace / 1073741824.0, 1), "totalGB", Math.Round(d.TotalSize / 1073741824.0, 1))); } } catch { }
    const string cv = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    int build = 0; int.TryParse(Convert.ToString(Reg(Registry.LocalMachine, cv, "CurrentBuild") ?? "0"), out build);
    string product = Convert.ToString(Reg(Registry.LocalMachine, cv, "ProductName") ?? "Windows"); if (build >= 22000) product = product.Replace("Windows 10", "Windows 11");
    return D("cpu", Convert.ToString(Reg(Registry.LocalMachine, @"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString") ?? "").Trim(), "threads", Environment.ProcessorCount,
      "ramMB", Math.Round(ms.ullTotalPhys / 1048576.0), "commitLimitMB", Math.Round(ms.ullTotalPageFile / 1048576.0), "pagefileMB", Math.Round((ms.ullTotalPageFile - (double)ms.ullTotalPhys) / 1048576.0),
      "os", product, "osVersion", Convert.ToString(Reg(Registry.LocalMachine, cv, "DisplayVersion") ?? ""), "osBuild", build + "." + Convert.ToString(Reg(Registry.LocalMachine, cv, "UBR") ?? ""),
      "gpus", gpus, "disks", disks, "screen", W.GetSystemMetrics(0) + " x " + W.GetSystemMetrics(1), "uptimeMin", Math.Round(W.GetTickCount64() / 60000.0),
      "board", Convert.ToString(Reg(Registry.LocalMachine, @"HARDWARE\DESCRIPTION\System\BIOS", "BaseBoardProduct") ?? ""), "bios", Convert.ToString(Reg(Registry.LocalMachine, @"HARDWARE\DESCRIPTION\System\BIOS", "BIOSVersion") ?? ""));
  }
  static object Modules(int pid) {       // the DLLs loaded in the game (overlays and mods show up here); Windows refuses for protected games
    IntPtr h = W.OpenProcess(W.QUERY_INFO | W.VM_READ, false, pid); if (h == IntPtr.Zero) return D("ok", false, "error", "Windows doesn't allow looking inside this game (it is protected).");
    try {
      var mods = new IntPtr[2048]; int need; if (!W.EnumProcessModulesEx(h, mods, mods.Length * IntPtr.Size, out need, 3)) return D("ok", false, "error", "the list couldn't be read");
      var list = new List<string>(); int n = Math.Min(mods.Length, need / IntPtr.Size);
      for (int i = 0; i < n; i++) { var sb = new StringBuilder(600); if (W.GetModuleFileNameExW(h, mods[i], sb, 600) > 0) list.Add(sb.ToString()); }
      return D("ok", true, "list", list);
    } finally { W.CloseHandle(h); }
  }
  static object VerInfo(string path) {
    try { var v = FileVersionInfo.GetVersionInfo(path); var fi = new FileInfo(path);
      return D("ok", true, "product", v.ProductName ?? "", "company", v.CompanyName ?? "", "description", v.FileDescription ?? "", "version", v.ProductVersion ?? v.FileVersion ?? "", "fileVersion", v.FileVersion ?? "", "sizeMB", Math.Round(fi.Length / 1048576.0, 1), "modified", ToMs(fi.LastWriteTimeUtc));
    } catch (Exception e) { return D("ok", false, "error", e.Message); }
  }
  // Windows can save a small crash dump whenever a given program crashes (Windows Error Reporting "LocalDumps").
  const string LD = @"SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps";
  static object LocalDumps(string exe, string mode, string dir) {
    if (exe.Length == 0 || exe.IndexOfAny(new[] { '\\', '/', '"' }) >= 0) return D("ok", false, "error", "bad name");
    try {
      if (mode == "get") { using (var k = Registry.LocalMachine.OpenSubKey(LD + "\\" + exe)) return D("ok", true, "on", k != null, "dir", k == null ? "" : Convert.ToString(k.GetValue("DumpFolder") ?? "")); }
      if (mode == "on") { Directory.CreateDirectory(dir); using (var k = Registry.LocalMachine.CreateSubKey(LD + "\\" + exe)) { k.SetValue("DumpFolder", dir, RegistryValueKind.ExpandString); k.SetValue("DumpType", 1, RegistryValueKind.DWord); k.SetValue("DumpCount", 5, RegistryValueKind.DWord); } return D("ok", true, "on", true, "dir", dir); }
      using (var k = Registry.LocalMachine.OpenSubKey(LD, true)) { if (k != null) k.DeleteSubKeyTree(exe, false); }
      return D("ok", true, "on", false);
    } catch (UnauthorizedAccessException) { return D("ok", false, "needAdmin", true); }
    catch (System.Security.SecurityException) { return D("ok", false, "needAdmin", true); }
    catch (Exception e) { return D("ok", false, "error", e.Message); }
  }
  static object Elevated(string exe, string mode, string dir) {       // the same, after asking Windows for administrator rights
    try {
      var psi = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--localdumps \"" + exe + "\" " + mode + " \"" + dir + "\"") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
      using (var p = Process.Start(psi)) { p.WaitForExit(20000); return D("ok", p.ExitCode == 0, "on", mode == "on", "dir", dir); }
    } catch (Exception e) { return D("ok", false, "error", "Administrator rights were not given (" + e.Message + ")."); }
  }

  // ------------------------------------------------------------------ commands
  static string S(Dictionary<string, object> c, string k) { object v; return c.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : ""; }
  static long L(Dictionary<string, object> c, string k, long def) { object v; if (!c.TryGetValue(k, out v) || v == null) return def; try { return Convert.ToInt64(v); } catch { return def; } }
  static object[] A(Dictionary<string, object> c, string k) { object v; if (!c.TryGetValue(k, out v) || v == null) return new object[0]; var al = v as System.Collections.ArrayList; if (al != null) return al.ToArray(); var oa = v as object[]; return oa ?? new object[0]; }

  static Dictionary<string, object> Handle(Dictionary<string, object> c) {
    string cmd = S(c, "cmd");
    switch (cmd) {
      case "hello": return D("ok", true, "version", 1, "pid", Process.GetCurrentProcess().Id);
      case "procs": return D("ok", true, "list", Procs(false));
      case "allprocs": return D("ok", true, "list", Snapshot().Select(e => e.szExeFile).Distinct(StringComparer.OrdinalIgnoreCase).ToList());
      case "watch":
        watchNames = new HashSet<string>(A(c, "names").Select(x => Convert.ToString(x)), StringComparer.OrdinalIgnoreCase);
        ignoreNames = new HashSet<string>(A(c, "ignore").Select(x => Convert.ToString(x)), StringComparer.OrdinalIgnoreCase);
        autoGames = L(c, "auto", 1) != 0; interval = (int)Math.Max(1000, Math.Min(10000, L(c, "interval", 2000)));
        lock (seen) seen.Clear();
        return D("ok", true);
      case "attach": { int pid = (int)L(c, "pid", 0); bool ok = Attach(pid, "picked"); if (ok) seen.Add(pid); return ok ? D("ok", true) : D("ok", false, "error", "Windows didn't allow watching that program (try running aGoldenDiagnose as administrator)."); }
      case "detach": Detach((int)L(c, "pid", 0)); return D("ok", true);
      case "events": return D("ok", true, "list", Events(L(c, "from", 0), L(c, "to", Now())));
      case "scan": return D("ok", true, "result", Scan(A(c, "roots"), A(c, "tokens").Select(x => Convert.ToString(x).ToLowerInvariant()).Where(x => x.Length >= 3).ToArray(), L(c, "from", 0), L(c, "to", Now())));
      case "copy": return D("ok", true, "files", CopyFiles(A(c, "files"), S(c, "dest"), L(c, "maxBytes", 300000000), L(c, "tailBytes", 4000000)));
      case "dump": try { return Dump(S(c, "path")); } catch (Exception e) { return D("ok", false, "error", e.Message); }
      case "sysinfo": return D("ok", true, "info", SysInfo());
      case "pc": return D("ok", true, "pc", Pc(L(c, "top", 0) != 0));
      case "temps": return (Dictionary<string, object>)Temps();
      case "net": return D("ok", true, "net", NetCheck(A(c, "hosts").Select(x => Convert.ToString(x)).ToList(), S(c, "name")));
      case "keepalive": kaExe = S(c, "exe"); kaOn = L(c, "on", 0) != 0; return D("ok", true);
      case "modules": return (Dictionary<string, object>)Modules((int)L(c, "pid", 0));
      case "verinfo": return (Dictionary<string, object>)VerInfo(S(c, "path"));
      case "localdumps": { var r = (Dictionary<string, object>)LocalDumps(S(c, "exe"), S(c, "mode"), S(c, "dir")); if (r.ContainsKey("needAdmin") && L(c, "elevate", 0) != 0) r = (Dictionary<string, object>)Elevated(S(c, "exe"), S(c, "mode"), S(c, "dir")); return r; }
      case "zip": try { string outp = S(c, "out"); if (File.Exists(outp)) File.Delete(outp); ZipFile.CreateFromDirectory(S(c, "dir"), outp, CompressionLevel.Optimal, false); return D("ok", true, "size", new FileInfo(outp).Length); } catch (Exception e) { return D("ok", false, "error", e.Message); }
      default: return D("ok", false, "error", "unknown command");
    }
  }

  // ------------------------------------------------------------------ the whole PC (the PC tab), asked every few seconds
  static PerformanceCounter pcCpu; static int pcTick = 0; static long pcTopAt = 0;
  static readonly Dictionary<int, double> pcCpuPrev = new Dictionary<int, double>();
  static object Pc(bool top) {
    var ms = new W.MEMSTAT(); ms.dwLength = (uint)Marshal.SizeOf(typeof(W.MEMSTAT)); W.GlobalMemoryStatusEx(ref ms);
    double cpu = -1; try { if (pcCpu == null) { pcCpu = new PerformanceCounter("Processor", "% Processor Time", "_Total", true); pcCpu.NextValue(); } else cpu = Math.Round(pcCpu.NextValue(), 1); } catch { }
    bool busy; lock (watched) busy = watched.Count > 0;            // while a game is watched the sampler already keeps the graphics counters fresh
    double gUse = -1, gMem = -1;
    try { if (!busy) { if (pcTick % 4 == 0) GpuRefresh(); if (pcTick % 2 == 0) Smi(); } pcTick++; if (gpuOk) { gUse = GpuUse(-1); gMem = GpuMemMB(-1); } } catch { }
    // Windows' own graphics counters don't answer on every PC: the driver's tool is the better source when it is there
    if (smiUse >= 0) gUse = Math.Round(smiUse); if (smiMem >= 0) gMem = Math.Round(smiMem);
    var drives = new List<object>();
    try { foreach (var d in DriveInfo.GetDrives()) { if (d.DriveType != DriveType.Fixed || !d.IsReady) continue; drives.Add(D("name", d.Name.TrimEnd('\\'), "label", d.VolumeLabel, "free", d.AvailableFreeSpace, "total", d.TotalSize)); } } catch { }
    var nets = new List<object>(); long rx = 0, tx = 0;
    try {
      foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
        if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
        string desc = ni.Description ?? ""; string dl = desc.ToLowerInvariant();
        if (dl.Contains("virtual") || dl.Contains("hyper-v") || dl.Contains("vmware") || dl.Contains("bluetooth") || dl.Contains("loopback") || dl.Contains("wi-fi direct")) continue;
        bool up = ni.OperationalStatus == OperationalStatus.Up; string ip = "", gw = "";
        try { var pr = ni.GetIPProperties(); foreach (var a in pr.UnicastAddresses) if (a.Address.AddressFamily == AddressFamily.InterNetwork) { ip = a.Address.ToString(); break; } foreach (var g in pr.GatewayAddresses) if (g.Address.AddressFamily == AddressFamily.InterNetwork && g.Address.ToString() != "0.0.0.0") { gw = g.Address.ToString(); break; } } catch { }
        if (up && gw.Length > 0) { try { var st = ni.GetIPv4Statistics(); rx += st.BytesReceived; tx += st.BytesSent; } catch { } }
        nets.Add(D("name", ni.Name, "desc", desc, "wifi", ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211, "up", up, "mbps", up && ni.Speed > 0 ? Math.Round(ni.Speed / 1e6) : 0, "ip", ip, "gateway", gw));
      }
    } catch { }
    var r = D("t", Now(), "cpu", cpu, "cores", Environment.ProcessorCount, "ramTotal", (double)ms.ullTotalPhys, "ramFree", (double)ms.ullAvailPhys, "commitTotal", (double)ms.ullTotalPageFile, "commitFree", (double)ms.ullAvailPageFile,
      "gpu", gUse, "vramMB", gMem, "vramTotalMB", smiMemTotal, "gpuFan", smiFan, "gpuName", smiName, "gpuTemp", gpuTemp, "gpuPower", gpuPower, "drives", drives, "nets", nets, "rx", (double)rx, "tx", (double)tx, "upMs", (double)(Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency));
    if (top) {
      long now = Now(); double dt = pcTopAt > 0 ? (now - pcTopAt) / 1000.0 : 0; pcTopAt = now;
      var rows = new List<Dictionary<string, object>>(); var seenPids = new HashSet<int>();
      foreach (var p in Process.GetProcesses()) {
        try {
          int pid = p.Id; if (pid <= 4) continue; seenPids.Add(pid);
          double cpuSec = -1; try { cpuSec = p.TotalProcessorTime.TotalSeconds; } catch { }
          double pc = 0; double prev; if (cpuSec >= 0 && dt > 0 && pcCpuPrev.TryGetValue(pid, out prev)) pc = Math.Max(0, Math.Round((cpuSec - prev) / dt / Environment.ProcessorCount * 100, 1));
          if (cpuSec >= 0) pcCpuPrev[pid] = cpuSec;
          rows.Add(D("name", p.ProcessName, "pid", pid, "cpu", pc, "mem", (double)p.WorkingSet64));
        } catch { } finally { try { p.Dispose(); } catch { } }
      }
      foreach (int gone in pcCpuPrev.Keys.Where(k => !seenPids.Contains(k)).ToList()) pcCpuPrev.Remove(gone);
      r["topCpu"] = rows.OrderByDescending(x => (double)x["cpu"]).Take(6).ToList();
      r["topMem"] = rows.OrderByDescending(x => (double)x["mem"]).Take(6).ToList();
      r["procs"] = rows.Count;
    }
    return r;
  }
  // ------------------------------------------------------------------ temperatures Windows gives without a driver
  // Each drive's own sensor (the storage "temperature" query, Windows 10 and later: no administrator rights needed for
  // NVMe and most SATA drives), and the motherboard's ACPI thermal zones (a performance counter; many desktops only
  // report a fixed value there). The processor's own sensor needs a driver, so it isn't read here.
  static class TW {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inSize, byte[] outBuf, int outSize, out int ret, IntPtr ov);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  }
  static byte[] StorageQuery(IntPtr h, int property) {
    var q = new byte[12]; BitConverter.GetBytes(property).CopyTo(q, 0);      // PropertyId, QueryType 0 (standard)
    var o = new byte[4096]; int n;
    return TW.DeviceIoControl(h, 0x2D1400, q, q.Length, o, o.Length, out n, IntPtr.Zero) && n >= 8 ? o : null;
  }
  static string AsciiAt(byte[] b, int off) { if (off <= 0 || off >= b.Length) return ""; int e = off; while (e < b.Length && b[e] != 0) e++; return Encoding.ASCII.GetString(b, off, e - off).Trim(); }
  static object Temps() {
    var letters = new Dictionary<int, string>();
    try {
      foreach (var d in DriveInfo.GetDrives()) {
        if (d.DriveType != DriveType.Fixed) continue;
        IntPtr h = TW.CreateFile(@"\\.\" + d.Name.TrimEnd('\\'), 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); if (h == new IntPtr(-1)) continue;
        try { var o = new byte[12]; int n; if (TW.DeviceIoControl(h, 0x2D1080, null, 0, o, 12, out n, IntPtr.Zero) && n >= 8) { int num = BitConverter.ToInt32(o, 4); string l; letters.TryGetValue(num, out l); letters[num] = (l == null ? "" : l + " ") + d.Name.TrimEnd('\\'); } } finally { TW.CloseHandle(h); }
      }
    } catch { }
    var drives = new List<object>();
    for (int i = 0; i < 16; i++) {
      IntPtr h = TW.CreateFile(@"\\.\PhysicalDrive" + i, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) continue;
      try {
        string model = ""; var dd = StorageQuery(h, 0);                      // StorageDeviceProperty: the product name (never the serial number)
        if (dd != null) { model = (AsciiAt(dd, BitConverter.ToInt32(dd, 12)) + " " + AsciiAt(dd, BitConverter.ToInt32(dd, 16))).Trim(); }
        var t = StorageQuery(h, 52);                                         // StorageDeviceTemperatureProperty
        if (t == null) continue;
        int count = BitConverter.ToUInt16(t, 12); if (count < 1) continue;
        short crit = BitConverter.ToInt16(t, 8), warn = BitConverter.ToInt16(t, 10), c = BitConverter.ToInt16(t, 26);
        if (c <= 0 || c > 120) continue;
        string l; letters.TryGetValue(i, out l);
        drives.Add(D("n", "PhysicalDrive" + i, "model", model, "c", (int)c, "warn", warn > 0 && warn < 150 ? (int)warn : 0, "crit", crit > 0 && crit < 150 ? (int)crit : 0, "letters", l ?? ""));
      } catch { } finally { TW.CloseHandle(h); }
    }
    var acpi = new List<object>();
    try {
      if (PerformanceCounterCategory.Exists("Thermal Zone Information")) {
        var cat = new PerformanceCounterCategory("Thermal Zone Information");
        foreach (string inst in cat.GetInstanceNames()) {
          try { using (var pcn = new PerformanceCounter("Thermal Zone Information", "Temperature", inst, true)) { double k = pcn.NextValue(); if (k > 200 && k < 400) acpi.Add(D("name", inst, "c", Math.Round(k - 273.15, 1))); } } catch { }
        }
      }
    } catch { }
    return D("ok", true, "drives", drives, "acpi", acpi);
  }

  // Is the internet there? Answers from the router, from two addresses on the internet, and from the name server (asked
  // directly with a small question, so Windows' own memory of names doesn't hide a name server that stopped answering).
  static double PingMs(string host, int timeout) {
    try { using (var p = new Ping()) { var r = p.Send(host, timeout); return r != null && r.Status == IPStatus.Success ? Math.Max(1, r.RoundtripTime) : -1; } } catch { return -1; }
  }
  static double DnsMs(string server, string name, int timeout) {
    try {
      var q = new List<byte> { 0x5a, 0x7e, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
      foreach (string part in name.Split('.')) { q.Add((byte)part.Length); q.AddRange(Encoding.ASCII.GetBytes(part)); }
      q.AddRange(new byte[] { 0, 0, 1, 0, 1 });
      using (var u = new UdpClient(AddressFamily.InterNetwork)) {
        u.Client.ReceiveTimeout = timeout; var sw = Stopwatch.StartNew();
        u.Send(q.ToArray(), q.Count, new IPEndPoint(IPAddress.Parse(server), 53));
        var from = new IPEndPoint(IPAddress.Any, 0); byte[] a = u.Receive(ref from);
        return a.Length >= 12 && a[0] == 0x5a && a[1] == 0x7e ? Math.Max(1, sw.ElapsedMilliseconds) : -1;
      }
    } catch { return -1; }
  }
  static object NetCheck(List<string> hosts, string name) {
    string gw = "", dns = "", adapter = ""; bool wifi = false, anyUp = false; double mbps = 0;
    try {
      foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
        if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
        var pr = ni.GetIPProperties(); string g = "";
        foreach (var x in pr.GatewayAddresses) if (x.Address.AddressFamily == AddressFamily.InterNetwork && x.Address.ToString() != "0.0.0.0") { g = x.Address.ToString(); break; }
        if (g.Length == 0) continue;
        anyUp = true; gw = g; adapter = ni.Name; wifi = ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211; mbps = ni.Speed > 0 ? Math.Round(ni.Speed / 1e6) : 0;
        foreach (var d in pr.DnsAddresses) if (d.AddressFamily == AddressFamily.InterNetwork) { dns = d.ToString(); break; }
        break;
      }
    } catch { }
    var res = new double[hosts.Count + 2]; var th = new List<Thread>();
    for (int i = 0; i < hosts.Count; i++) { int n = i; var t = new Thread(() => { try { res[n] = PingMs(hosts[n], 1500); } catch { res[n] = -1; } }) { IsBackground = true }; t.Start(); th.Add(t); }
    string gwc = gw, dnsc = dns;
    { var t = new Thread(() => { try { res[hosts.Count] = gwc.Length > 0 ? PingMs(gwc, 1000) : -1; } catch { res[hosts.Count] = -1; } }) { IsBackground = true }; t.Start(); th.Add(t); }
    { var t = new Thread(() => { try { res[hosts.Count + 1] = dnsc.Length > 0 ? DnsMs(dnsc, name, 1800) : -1; } catch { res[hosts.Count + 1] = -1; } }) { IsBackground = true }; t.Start(); th.Add(t); }
    foreach (var t in th) t.Join(2500);
    var pings = new List<object>(); for (int i = 0; i < hosts.Count; i++) pings.Add(D("host", hosts[i], "ms", res[i]));
    return D("t", Now(), "link", anyUp, "adapter", adapter, "wifi", wifi, "mbps", mbps, "gateway", gw, "gatewayMs", res[hosts.Count], "dns", dns, "dnsMs", res[hosts.Count + 1], "pings", pings);
  }
  // Keep alive: if the app is ended any other way than its own Quit (Task Manager, a crash), this helper is still there for
  // a moment, sees its line to the app close, and starts the app again in the tray.
  static string kaExe = ""; static bool kaOn = false;
  static bool AppRunning(string exe) { try { string n = Path.GetFileNameWithoutExtension(exe); int me = Process.GetCurrentProcess().Id; foreach (var p in Process.GetProcessesByName(n)) { try { if (p.Id != me) return true; } finally { p.Dispose(); } } } catch { } return false; }
  static void StartApp(string exe, string why) { try { Process.Start(new ProcessStartInfo(exe, "--hidden --revived=" + why) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) }); } catch { } }

  static int Main(string[] args) {
    AppDomain.CurrentDomain.UnhandledException += (o, e) => { try { Send(D("ev", "error", "message", "fatal: " + e.ExceptionObject)); } catch { } };
    // the every-few-minutes check Windows runs (Task Scheduler): start the app again if it isn't running, unless it was quit on purpose
    // (the argument is a small text file: first line the app's .exe, second line the "quit on purpose" marker file)
    if (args.Length >= 2 && args[0] == "--keepalive") {
      try { string[] l = File.ReadAllLines(args[1]); string exe = l.Length > 0 ? l[0].Trim() : "", flag = l.Length > 1 ? l[1].Trim() : ""; if (flag.Length > 0 && File.Exists(flag)) return 0; if (exe.Length == 0 || !File.Exists(exe) || AppRunning(exe)) return 0; StartApp(exe, "task"); } catch { }
      return 0;
    }
    if (args.Length >= 3 && args[0] == "--localdumps") { var r = (Dictionary<string, object>)LocalDumps(args[1], args[2], args.Length > 3 ? args[3] : ""); return Convert.ToBoolean(r["ok"]) ? 0 : 1; }
    if (args.Length == 2 && args[0] == "--dump") { Console.WriteLine(js.Serialize(Dump(args[1]))); return 0; }
    try { Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false); } catch { }
    var t = new Thread(() => { for (;;) { try { Tick(); } catch (Exception e) { Send(D("ev", "error", "message", e.Message)); } Thread.Sleep(interval); } }) { IsBackground = true };
    t.Start();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      Dictionary<string, object> c = null; object id = null;
      try { c = js.Deserialize<Dictionary<string, object>>(line); c.TryGetValue("id", out id); } catch { continue; }
      if (S(c, "cmd") == "quit") { kaOn = false; break; }
      // slow questions (event log, file search) run beside the sampler so watching never pauses
      var cc = c; var cid = id;
      ThreadPool.QueueUserWorkItem(_ => { Dictionary<string, object> r; try { r = Handle(cc); } catch (Exception e) { r = D("ok", false, "error", e.Message); } r["re"] = cid; Send(r); });
    }
    if (kaOn && kaExe.Length > 0 && File.Exists(kaExe)) { Thread.Sleep(2500); if (!AppRunning(kaExe)) StartApp(kaExe, "ended"); }
    return 0;
  }
}
