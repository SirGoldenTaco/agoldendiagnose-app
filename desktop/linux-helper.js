// aGoldenDiagnose helper for Linux: the part that talks to the system (the Windows version is helper/AgdHelper.cs).
//
// It WATCHES a game from the outside. It never injects anything into the game, never attaches a debugger (no ptrace) and
// never reads the game's memory: it only reads what Linux publishes about every process in /proc (is it alive, how much
// CPU and memory it uses), the same place `top` and the system monitor read. It needs no root and asks for none.
//
// The app starts this once (with Electron's own Node) and talks to it over stdin / stdout, one JSON object per line:
//   -> {"id":1,"cmd":"procs"}                      <- {"re":1,"ok":true,"list":[...]}
//   <- {"ev":"found",...}  {"ev":"s",...}  {"ev":"exit",...}      (things it reports by itself)
//
// What Linux can't tell an outside program: the exit code of a process it didn't start, and whether a window stopped
// answering. So a crash is recognised from what is left behind instead: a core dump recorded by systemd, a line in the
// kernel log (segfault, graphics driver reset, out-of-memory kill), and the game's own log and crash files.
//
// The system log's lines are handed to the app in the same shape the Windows helper uses for Windows' event log
// (the "provider" names below), so one reading of a report serves both systems.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), dgram = require("dgram"), net = require("net"), zlib = require("zlib");
const { execFile, spawn } = require("child_process");

const send = (o) => { try { process.stdout.write(JSON.stringify(o) + "\n"); } catch {} };
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const num = (s) => { const n = parseFloat(s); return isFinite(n) ? n : -1; };
const run = (cmd, args, timeout) => new Promise((res) => { try { execFile(cmd, args, { timeout: timeout || 5000, maxBuffer: 64 << 20, encoding: "utf8" }, (e, out) => res(String(out || ""))); } catch { res(""); } });
const which = (name) => { for (const d of (process.env.PATH || "/usr/bin:/bin").split(":").concat(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])) { const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} } return ""; };
const CPUS = os.cpus().length || 1, TICK = 100;          // clock ticks per second: 100 on every common Linux
const BOOT = (() => { const m = /^btime (\d+)/m.exec(read("/proc/stat")); return m ? +m[1] * 1000 : Date.now() - os.uptime() * 1000; })();

/* ------------------------------------------------------------------ processes */
// Where game stores keep their games: a program started from one of these is treated as a game.
const LIBS = ["/steamapps/common/", "/gog games/", "/games/", "/heroic/", "/lutris/", "/bottles/", "/itch/apps/", "/epic games/", "/legendary/", "/.minecraft/"];
// Helpers that live in those folders (or run the game) but are not the game itself.
const NOT_GAMES = ["crash", "report", "launcher", "anticheat", "easyanticheat", "beservice", "battleye", "webhelper", "cefprocess", "cefsubprocess", "qtwebengine", "redist", "vc_redist", "dxsetup", "dotnet", "installer", "uninstall", "unins", "setup", "overlay", "updater", "update", "helper", "bootstrap", "prereq", "socialclub", "steamservice", "steamerrorreporter", "epicwebhelper", "ucsvc", "upc.exe", "touchup", "cleanup", "config", "diagnos", "benchmark", "server", "editor", "sdk", "activation", "language", "subprocess", "vrserver", "vrmonitor", "vrcompositor", "vrdashboard", "steamvr", "wallpaper",
  "wine", "proton", "python", "reaper", "pv-", "pressure-vessel", "srt-", "gamescope", "mangohud", "gamemode", "iscriptevaluator", "d3ddriverquery", "xdg-", "bwrap", "steam.exe", "explorer.exe", "services.exe", "winedevice.exe", "plugplay.exe", "rpcss.exe", "svchost.exe", "tabtip.exe", "conhost.exe", "start.exe", "cmd.exe"];
const NOT_PATHS = ["/steamapps/common/proton", "/steamapps/common/steamlinuxruntime", "/steamapps/common/steamworks", "/compatibilitytools.d/", "/steam-runtime/", "/ubuntu12_32/", "/ubuntu12_64/", "/drive_c/windows/", "/files/bin/wine", "/dist/bin/wine"];
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "env", "sudo", "java", "node", "electron"]);

const envOf = (pid) => { const e = {}; for (const kv of read("/proc/" + pid + "/environ").split("\0")) { const i = kv.indexOf("="); if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1); } return e; };
const statOf = (pid) => { const s = read("/proc/" + pid + "/stat"), i = s.lastIndexOf(")"); if (i < 0) return null; const f = s.slice(i + 2).split(" "); return { comm: s.slice(s.indexOf("(") + 1, i), state: f[0], ppid: +f[1] || 0, cpuTicks: (+f[11] || 0) + (+f[12] || 0), threads: +f[17] || 0, startMs: BOOT + ((+f[19] || 0) / TICK) * 1000 }; };
const ancestors = (pid) => { const out = []; let p = pid; for (let i = 0; i < 40; i++) { const st = statOf(p); if (!st || st.ppid <= 1) break; p = st.ppid; out.push(p); } return out; };
/** What a process is: its program's name and path. A Windows game run by Wine / Proton is named after its .exe. */
function info(pid) {
  const cl = read("/proc/" + pid + "/cmdline"); if (!cl) return null;          // kernel threads have no command line
  const argv = cl.split("\0"), a0 = argv[0] || "";
  let exe = ""; try { exe = fs.readlinkSync("/proc/" + pid + "/exe").replace(/ \(deleted\)$/, ""); } catch {}
  let win = /\.exe$/i.test(a0) ? a0 : "";
  if (!win && /^wine(64)?(-preloader)?$/.test(path.basename(exe))) win = argv.slice(1).find((a) => /\.exe$/i.test(a)) || "";
  if (win) {
    const env = envOf(pid), prefix = env.WINEPREFIX || (env.STEAM_COMPAT_DATA_PATH ? path.join(env.STEAM_COMPAT_DATA_PATH, "pfx") : "");
    let p = win.replace(/\\/g, "/");
    if (/^[zZ]:\//.test(p)) p = p.slice(2);
    else if (/^[a-zA-Z]:\//.test(p)) { if (prefix) { p = path.join(prefix, "dosdevices", p[0].toLowerCase() + ":", p.slice(3)); try { p = fs.realpathSync(p); } catch {} } }
    else if (!p.startsWith("/")) { try { p = path.join(fs.readlinkSync("/proc/" + pid + "/cwd"), p); } catch {} }
    return { pid, name: path.basename(p), path: p, prefix, wine: true };
  }
  return { pid, name: path.basename(exe || a0), path: exe, prefix: "", wine: false };
}
const engineDirs = new Map();
const ENGINE_FILES = ["UnityPlayer.so", "UnityPlayer.dll", "GameAssembly.so", "GameAssembly.dll", "libsteam_api.so", "steam_api64.dll", "steam_api.dll", "steam_appid.txt", "EOSSDK-Win64-Shipping.dll", "libEOSSDK-Linux-Shipping.so", "Galaxy64.dll", "libGalaxy64.so", "libfmod.so", "fmod.dll", "bink2w64.dll", "nvngx_dlss.dll", "D3D12Core.dll", "data.win", "game.unx", "nw.pak"];
function engineFolder(p, nameLow) {          // a game installed anywhere else is recognised by what sits next to it
  const dir = path.dirname(p), d = dir.toLowerCase() + "/";
  if (!dir || dir === "/" || /^\/(usr|bin|sbin|lib|lib64|opt\/google|snap|proc|sys|nix\/store|var\/lib\/(flatpak|snapd))\//.test(d) || d.includes("/.config/") || d.includes("/.cache/") || d.includes("/node_modules/")) return false;
  if (engineDirs.has(dir)) return engineDirs.get(dir);
  let yes = /-(win64|linux)-shipping/.test(nameLow) || /\/binaries\/(win64|linux)\/$/.test(d);          // Unreal Engine
  try {
    if (!yes) yes = ENGINE_FILES.some((f) => fs.existsSync(path.join(dir, f)));
    if (!yes) yes = fs.existsSync(path.join(dir, path.basename(p).replace(/\.(exe|x86_64|x86)$/i, "") + "_Data"));          // Unity
    if (!yes) yes = fs.readdirSync(dir).some((f) => /\.(pck|rpa)$/i.test(f));          // Godot, Ren'Py
  } catch {}
  engineDirs.set(dir, yes); return yes;
}
function looksLikeGame(i) {
  const p = (i.path || "").toLowerCase(), n = i.name.toLowerCase();
  if (!p || !p.startsWith("/") || SHELLS.has(n)) return false;
  if (NOT_GAMES.some((b) => n.includes(b)) || NOT_PATHS.some((b) => p.includes(b))) return false;
  if (LIBS.some((m) => p.includes(m))) return true;
  return engineFolder(i.path, n);
}
const pids = () => { try { return fs.readdirSync("/proc").filter((x) => x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57).map(Number); } catch { return []; } };

const watched = new Map();          // pid -> { pid, name, path, startMs, lastTicks, lastWall }
const known = new Map();            // pid -> full program name of games seen lately (the kernel log only has the first 15 letters)
let watchNames = new Set(), ignoreNames = new Set(), autoGames = true, interval = 2000;
let runPids = new Set();          // games started through the Steam launch option: what they start is watched even when watching by itself is off
const seen = new Set(), looks = new Map();
function attach(pid, why, i) {
  if (watched.has(pid)) return true;
  i = i || info(pid); const st = statOf(pid); if (!i || !st) return false;
  watched.set(pid, { pid, name: i.name, path: i.path, startMs: st.startMs, lastTicks: st.cpuTicks, lastWall: Date.now() });
  known.set(pid, { name: i.name, t: Date.now() });
  send({ ev: "found", pid, name: i.name, path: i.path, startMs: Math.round(st.startMs), title: "", why, prefix: i.prefix || "", wine: !!i.wine, anc: ancestors(pid) });
  return true;
}
function procs() {          // the list to pick a game from: your own programs that aren't part of the system
  const me = process.pid, mine = process.getuid ? process.getuid() : -1, list = [];
  for (const pid of pids()) {
    if (pid === me || pid === process.ppid) continue;
    try { if (mine >= 0 && fs.statSync("/proc/" + pid).uid !== mine) continue; } catch { continue; }
    const i = info(pid); if (!i || !i.path || !i.path.startsWith("/")) continue;
    const low = i.path.toLowerCase(), game = looksLikeGame(i);
    if (!game && (/^\/(usr|bin|sbin|lib|lib64|snap|opt|nix)\//.test(low) || NOT_PATHS.some((b) => low.includes(b)) || SHELLS.has(i.name.toLowerCase()))) continue;
    const st = statOf(pid);
    list.push({ pid, name: i.name, path: i.path, title: "", threads: st ? st.threads : 0, game, watched: watched.has(pid) });
  }
  return list;
}

/* ------------------------------------------------------------------ the graphics card */
const G = { use: -1, mem: -1, memTotal: -1, temp: -1, power: -1, fan: -1, name: "", per: new Map(), busy: false, smi: null, card: null };
function amdCard() {          // AMD and Intel cards publish their numbers as files
  if (G.card !== null) return G.card;
  G.card = "";
  try { for (const c of fs.readdirSync("/sys/class/drm")) { if (!/^card\d+$/.test(c)) continue; const d = "/sys/class/drm/" + c + "/device"; if (fs.existsSync(d + "/gpu_busy_percent")) { G.card = d; break; } } } catch {}
  return G.card;
}
async function gpuRead() {
  if (G.busy) return; G.busy = true;
  try {
    if (G.smi === null) G.smi = which("nvidia-smi");
    if (G.smi) {
      const f = (await run(G.smi, ["--query-gpu=temperature.gpu,power.draw,utilization.gpu,memory.used,memory.total,fan.speed,name", "--format=csv,noheader,nounits"], 2500)).split("\n")[0].split(",");
      if (f.length >= 5) { G.temp = num(f[0]); G.power = Math.round(num(f[1])); G.use = num(f[2]); G.mem = num(f[3]); G.memTotal = num(f[4]); G.fan = num(f[5]); G.name = (f[6] || "").trim(); }
      if (watched.size) {          // what each program uses of the card, from the driver's own tool
        const out = await run(G.smi, ["pmon", "-c", "1", "-s", "um"], 3000), lines = out.split("\n"), head = (lines.find((l) => /^#\s*gpu\s+pid/i.test(l)) || "").replace(/^#\s*/, "").trim().split(/\s+/);
        const ip = head.indexOf("pid"), iu = head.indexOf("sm"), im = head.indexOf("fb"); G.per.clear();
        if (ip >= 0) for (const l of lines) { if (!l || l[0] === "#") continue; const c = l.trim().split(/\s+/), pid = +c[ip]; if (pid > 0) G.per.set(pid, { use: iu >= 0 ? num(c[iu]) : -1, mem: im >= 0 ? num(c[im]) : -1 }); }
      }
    } else if (amdCard()) {
      const d = G.card; G.use = num(read(d + "/gpu_busy_percent"));
      const u = num(read(d + "/mem_info_vram_used")), t = num(read(d + "/mem_info_vram_total")); if (u >= 0) G.mem = Math.round(u / 1048576); if (t > 0) G.memTotal = Math.round(t / 1048576);
      try { for (const h of fs.readdirSync(d + "/hwmon")) { const b = d + "/hwmon/" + h; const tt = num(read(b + "/temp1_input")); if (tt > 0) G.temp = Math.round(tt / 1000); const pw = num(read(b + "/power1_average")); if (pw > 0) G.power = Math.round(pw / 1e6); } } catch {}
    }
  } finally { G.busy = false; }
}

/* AMD and Intel cards: what one program uses of the card, from the kernel's per-program counters (/proc/<pid>/fdinfo
 * of its /dev/dri files), readable without administrator rights. NVIDIA's driver tool covers NVIDIA cards above. */
const UNIT = { KiB: 1 / 1024, MiB: 1, GiB: 1024 };
function drmUse(w, now) {
  if (!w.drmFds || (w.drmAge = (w.drmAge || 0) + 1) % 15 === 0) {
    w.drmFds = [];
    try { for (const fd of fs.readdirSync("/proc/" + w.pid + "/fd")) { let l = ""; try { l = fs.readlinkSync("/proc/" + w.pid + "/fd/" + fd); } catch {} if (l.startsWith("/dev/dri/")) w.drmFds.push(fd); } } catch {}
  }
  if (!w.drmFds.length) return null;
  const clients = new Set(), eng = {}; let mem = 0, any = false;
  for (const fd of w.drmFds) {
    const t = read("/proc/" + w.pid + "/fdinfo/" + fd), id = (/^drm-client-id:\s*(\d+)/m.exec(t) || [])[1];
    if (!id || clients.has(id)) continue; clients.add(id); any = true;
    for (const m of t.matchAll(/^drm-engine-([\w-]+):\s*(\d+) ns/gm)) eng[m[1]] = (eng[m[1]] || 0) + Number(m[2]);
    const v = /^drm-(?:memory-vram|total-local\d*|resident-local\d*):\s*(\d+) (KiB|MiB|GiB)/m.exec(t); if (v) mem += Number(v[1]) * (UNIT[v[2]] || 0);
  }
  if (!any) return null;
  let use = -1;
  if (w.drmPrev) { const dt = (now - w.drmPrev.t) * 1e6; if (dt > 0) for (const k of Object.keys(eng)) { if (w.drmPrev.eng[k] === undefined) continue; use = Math.max(use, Math.min(100, Math.round((eng[k] - w.drmPrev.eng[k]) / dt * 1000) / 10)); } }
  w.drmPrev = { t: now, eng };
  return { use, mem: mem > 0 ? Math.round(mem) : -1 };
}

/* ------------------------------------------------------------------ the sampler: one pass every `interval` */
let cpuPrev = null, gpuTick = 0;
function sysCpu(slot) {          // the whole PC's processor use since the last call from the same place
  const f = (read("/proc/stat").split("\n")[0] || "").trim().split(/\s+/).slice(1).map(Number); if (f.length < 5) return -1;
  const idle = f[3] + (f[4] || 0), total = f.reduce((a, b) => a + b, 0), prev = slot.prev; slot.prev = { idle, total };
  if (!prev || total <= prev.total) return -1;
  return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10;
}
function mem() {
  const m = {}; for (const l of read("/proc/meminfo").split("\n")) { const x = /^(\w+):\s+(\d+)/.exec(l); if (x) m[x[1]] = +x[2] * 1024; }
  const total = m.MemTotal || 0, free = m.MemAvailable !== undefined ? m.MemAvailable : (m.MemFree || 0), swapT = m.SwapTotal || 0, swapF = m.SwapFree || 0;
  return { total, free, commitTotal: total + swapT, commitFree: free + swapF };
}
const tickSlot = {}, pcSlot = {};
function tick() {
  const now = Date.now();
  if (autoGames || watchNames.size || runPids.size) {
    const alive = new Set();
    for (const pid of pids()) {
      alive.add(pid); if (seen.has(pid) || pid === process.pid) continue;
      const i = info(pid); if (!i) { seen.add(pid); continue; }
      const low = i.name.toLowerCase();
      if (ignoreNames.has(low)) { seen.add(pid); continue; }
      const named = watchNames.has(low), viaRun = runPids.size > 0 && ancestors(pid).some((a) => runPids.has(a));
      if (!named && !((autoGames || viaRun) && looksLikeGame(i))) {          // a program that just started may still be turning into the game: look a few more times
        const n = (looks.get(pid) || 0) + 1; if (n >= 4) { looks.delete(pid); seen.add(pid); } else looks.set(pid, n); continue;
      }
      looks.delete(pid); seen.add(pid); attach(pid, named ? "listed" : viaRun ? "launch option" : "library", i);
    }
    for (const p of seen) if (!alive.has(p)) seen.delete(p);
    for (const p of looks.keys()) if (!alive.has(p)) looks.delete(p);
  }
  for (const [p, k] of known) if (now - k.t > 15 * 60000 && !watched.has(p)) known.delete(p);
  if (!watched.size) return;
  if (gpuTick++ % 2 === 0) gpuRead();
  const sc = sysCpu(tickSlot), m = mem();
  for (const w of [...watched.values()]) {
    const st = statOf(w.pid);
    if (!st || st.state === "Z" || st.state === "X" || Math.abs(st.startMs - w.startMs) > 2000) {          // it ended (or its number was given to another program)
      known.set(w.pid, { name: w.name, t: now });
      send({ ev: "exit", pid: w.pid, code: 0, t: now, hungMs: 0, hungTotalMs: 0, unknownCode: true }); watched.delete(w.pid); continue;
    }
    const o = { ev: "s", pid: w.pid, t: now };
    o.cpu = Math.round(Math.min(100, ((st.cpuTicks - w.lastTicks) / TICK) / Math.max(0.001, (now - w.lastWall) / 1000) / CPUS * 100) * 10) / 10; w.lastTicks = st.cpuTicks; w.lastWall = now;
    const status = read("/proc/" + w.pid + "/status"), kb = (k) => { const x = new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(status); return x ? +x[1] : 0; };
    o.ws = Math.round(kb("VmRSS") / 1024); o.pm = Math.round((kb("RssAnon") + kb("VmSwap")) / 1024) || o.ws;
    let g = G.per.get(w.pid); if (!g && !G.smi) g = drmUse(w, now); o.gpu = g && g.use >= 0 ? g.use : -1; o.vram = g && g.mem >= 0 ? g.mem : -1;
    o.hung = 0; o.sc = sc; o.sm = m.total ? Math.round((1 - m.free / m.total) * 100) : -1; o.ramFree = Math.round(m.free / 1048576);
    o.commit = m.commitTotal ? Math.round((1 - m.commitFree / m.commitTotal) * 1000) / 10 : -1;
    o.sg = G.use; o.sv = G.mem; o.gt = G.temp; o.gp = G.power;
    send(o);
  }
}

/* ------------------------------------------------------------------ the system log (what Linux wrote down about the crash) */
const SIG = { 4: ["c000001d", "SIGILL"], 5: ["80000003", "SIGTRAP"], 6: ["40000015", "SIGABRT"], 7: ["c0000006", "SIGBUS"], 8: ["c0000094", "SIGFPE"], 11: ["c0000005", "SIGSEGV"] };
const COREDUMP_ID = "fc2e22bc6ee647b6b90729ab34a250b1";
let jctl = null;
async function journal(args, fromMs, toMs) {
  if (jctl === null) jctl = which("journalctl"); if (!jctl) return [];
  const out = await run(jctl, ["-o", "json", "--no-pager", "-q", "--since", "@" + Math.floor(fromMs / 1000), "--until", "@" + Math.ceil(toMs / 1000), "-n", "4000"].concat(args), 15000), rows = [];
  for (const l of out.split("\n")) { if (!l) continue; try { const j = JSON.parse(l); j._t = Math.round(+j.__REALTIME_TIMESTAMP / 1000) || 0; if (Array.isArray(j.MESSAGE)) j.MESSAGE = Buffer.from(j.MESSAGE).toString("utf8"); rows.push(j); } catch {} }
  return rows;
}
const fullName = (pid, comm) => { const k = known.get(+pid); return k && k.name.toLowerCase().startsWith(String(comm || "").toLowerCase().slice(0, 15)) ? k.name : String(comm || ""); };
async function events(fromMs, toMs) {
  const out = [], dumped = new Set(), ev = (provider, id, t, message, data, log) => out.push({ log: log || "System", provider, id, level: 2, t, message: String(message || "").slice(0, 2500), data: data || [] });
  // core dumps kept by systemd: which program, which signal, and where in it
  for (const j of await journal(["MESSAGE_ID=" + COREDUMP_ID], fromMs, toMs)) {
    const pid = +j.COREDUMP_PID || 0, sig = SIG[+j.COREDUMP_SIGNAL] || ["", j.COREDUMP_SIGNAL_NAME || ""], exe = j.COREDUMP_EXE || "", name = fullName(pid, j.COREDUMP_COMM || path.basename(exe));
    const fr = /#0\s+0x[0-9a-f]+\s+(\S+)\s+\(([^)\s]+)/i.exec(j.MESSAGE || ""), mod = fr ? path.basename(fr[2]) : "";
    dumped.add(pid);
    ev("Application Error", 1000, j._t, "Core dump: " + name + " (pid " + pid + ") ended with " + (sig[1] || "a signal") + (mod ? " in " + mod : "") + ".\n" + String(j.MESSAGE || "").split("\n").slice(0, 14).join("\n"), [name, "", "", mod, "", "", sig[0], "", String(pid), "", exe, mod], "Application");
  }
  // Ubuntu, Mint and others keep crash reports in /var/crash (apport) instead: the head of each file says what crashed and how
  try {
    for (const n of fs.readdirSync("/var/crash")) {
      if (!n.endsWith(".crash")) continue; const f = "/var/crash/" + n; let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < fromMs || st.mtimeMs > toMs + 600000) continue;
      let head = ""; try { const fd = fs.openSync(f, "r"), b = Buffer.alloc(Math.min(st.size, 262144)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString("utf8"); } catch { continue; }          // someone else's crash: not readable, skipped
      const get = (k) => ((new RegExp("^" + k + ": (.*)$", "m").exec(head) || [])[1] || "").trim();
      const exe = get("ExecutablePath"), sig = SIG[+get("Signal")] || ["", get("Signal") ? "signal " + get("Signal") : ""], pid = +((/^Pid:\s*(\d+)/m.exec(head) || [])[1] || 0), t = Date.parse(get("Date")) || Math.round(st.mtimeMs);
      if (!exe || t < fromMs || t > toMs || dumped.has(pid)) continue; dumped.add(pid);
      const top = (/^StacktraceTop:\n((?: .*\n?){1,5})/m.exec(head) || [])[1] || "", mod = path.basename((/ from (\S+)/.exec(top) || [])[1] || ""), name = fullName(pid, path.basename(exe));
      ev("Application Error", 1000, t, "Crash report (apport): " + name + " (pid " + pid + ") ended with " + (sig[1] || "a crash") + (mod ? " in " + mod : "") + "." + (top ? "\n" + top.trim() : ""), [name, "", "", mod, "", "", sig[0], "", String(pid), "", exe, mod], "Application");
    }
  } catch {}
  // the kernel's own lines
  for (const j of await journal(["-k"], fromMs, toMs)) {
    const m = String(j.MESSAGE || ""); let x;
    if ((x = /^(.+?)\[(\d+)\]: segfault at .*? in ([^\[\s]+)/.exec(m)) || (x = /^traps: (.+?)\[(\d+)\] (?:general protection|trap invalid opcode).*? in ([^\[\s]+)/.exec(m)) || (x = /^(.+?)\[(\d+)\]: segfault at/.exec(m))) {
      if (dumped.has(+x[2])) continue; const name = fullName(x[2], x[1]);
      ev("Application Error", 1000, j._t, m, [name, "", "", x[3] || "", "", "", /invalid opcode/.test(m) ? "c000001d" : "c0000005", "", x[2], "", "", x[3] || ""], "Application");
    }
    else if ((x = /Out of memory: Killed process (\d+) \((.+?)\)/.exec(m))) ev("Microsoft-Windows-Resource-Exhaustion-Detector", 2004, j._t, "The kernel ran out of memory and ended " + fullName(x[1], x[2]) + " to free some. " + m, [fullName(x[1], x[2])]);
    else if (/NVRM: Xid|amdgpu.*(ring \S+ timeout|GPU reset|device lost)|i915.*(GPU HANG|Resetting)|\[drm[^\]]*\] \*ERROR\*.*(timed? ?out|reset|hang)/i.test(m)) ev("Display", 4101, j._t, m, []);
    else if (/\[Hardware Error\]|Machine check events logged|mce: .*(CPU|Hardware)/i.test(m)) ev("Microsoft-Windows-WHEA-Logger", 1, j._t, m, []);
    else if (/(I\/O error, dev|blk_update_request: .*error|EXT4-fs error|BTRFS (error|critical)|XFS .*(corrupt|I\/O error)|nvme\d*: .*(timeout|I\/O error))/i.test(m)) ev("disk", 7, j._t, m, []);
  }
  return out;
}

/* ------------------------------------------------------------------ files the game wrote during the session */
const LOG_EXT = new Set([".log", ".txt", ".dmp", ".mdmp", ".hdmp", ".crash", ".rpt", ".wer", ".err", ".out", ".trace", ".xml", ".json", ".stacktrace", ".runtimexml", ".runtime-xml"]);
const LOG_WORDS = ["log", "crash", "error", "dump", "report", "trace", "output", "player", "exception", "debug", "stderr", "stdout", "diagnos", "fatal"];
const SKIP_DIRS = ["/node_modules/", "/cache/", "/shadercache/", "/shader_cache/", "/pipelinecaches/", "/webcache/", "/gpucache/", "/code cache/", "/assets/", "/content/paks/", "/movies/", "/__pycache__/", "/.git/", "/workshop/", "/screenshots/", "/replays/", "/savegames/", "/saves/", "/drive_c/windows/", "/dosdevices/", "/steamapps/shadercache/"];
function scanDir(dir, depth, c) {
  if (c.found.length >= 400 || Date.now() - c.t0 > 20000 || c.dirs > 60000) return;
  c.dirs++; const low = dir.toLowerCase() + "/", inToken = !c.needToken || c.tokens.some((t) => low.includes(t));
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase(); if (!LOG_EXT.has(ext)) continue;
    if (c.match && !c.match.test(e.name)) continue;
    const nameLow = e.name.toLowerCase(), dumpy = [".dmp", ".mdmp", ".hdmp", ".wer", ".crash"].includes(ext);
    if (!inToken && !c.tokens.some((t) => nameLow.includes(t))) continue;
    if (!dumpy && ext !== ".log" && !LOG_WORDS.some((w) => nameLow.includes(w) || low.includes("/" + w))) continue;
    const f = path.join(dir, e.name); let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < c.from || st.mtimeMs > c.to || st.size === 0) continue;
    c.found.push({ path: f, size: st.size, mtime: Math.round(st.mtimeMs), kind: dumpy ? (c.kind === "game" ? "game-dump" : "dump") : c.kind === "game" ? "game-log" : "log" });
    if (c.found.length >= 400) return;
  }
  if (depth >= c.maxDepth) return;
  for (const e of list) { if (!e.isDirectory() || e.isSymbolicLink()) continue; const sub = path.join(dir, e.name); if (SKIP_DIRS.some((s) => (sub.toLowerCase() + "/").includes(s))) continue; scanDir(sub, depth + 1, c); }
}
/** roots: [{path, depth, needToken, kind}]  tokens: lower-case words that tie a folder or file to this game */
function scan(roots, tokens, from, to) {
  const c = { found: [], dirs: 0, t0: Date.now(), tokens, from, to };
  for (const r of roots || []) { if (!r || !r.path || !fs.existsSync(r.path)) continue; c.maxDepth = r.depth | 0; c.needToken = !!r.needToken; c.kind = String(r.kind || "game"); try { c.match = r.match ? new RegExp(String(r.match), "i") : null; } catch { c.match = null; } scanDir(String(r.path).replace(/\/+$/, ""), 0, c); }
  return { files: c.found, dirs: c.dirs, ms: Date.now() - c.t0 };
}
/** Copies the found files into the report's folder. Text files over tailBytes keep their beginning and their end. */
function copyFiles(files, dest, maxBytes, tailBytes) {
  fs.mkdirSync(dest, { recursive: true }); const done = [], used = new Set();
  for (const d of files || []) {
    const src = String(d.path || ""), name = path.basename(src);
    try {
      const st = fs.statSync(src), ext = path.extname(name).toLowerCase(), binary = [".dmp", ".mdmp", ".hdmp"].includes(ext);
      if (binary && st.size > maxBytes) { done.push({ orig: src, name: "", size: st.size, skipped: "too big to copy (" + Math.floor(st.size / 1048576) + " MB): left where it is" }); continue; }
      let target = name, n = 2; while (used.has(target.toLowerCase())) target = path.basename(name, path.extname(name)) + " (" + n++ + ")" + path.extname(name);
      used.add(target.toLowerCase()); const full = path.join(dest, target); let cut = false;
      if (!binary && st.size > tailBytes) {
        cut = true; const head = Math.min(200000, Math.floor(tailBytes / 5)), fd = fs.openSync(src, "r"), a = Buffer.alloc(head), b = Buffer.alloc(tailBytes - head);
        try { const na = fs.readSync(fd, a, 0, head, 0), nb = fs.readSync(fd, b, 0, b.length, st.size - b.length); fs.writeFileSync(full, Buffer.concat([a.subarray(0, na), Buffer.from("\n\n[... aGoldenDiagnose left out the middle of this file (" + Math.floor((st.size - tailBytes) / 1024) + " KB) ...]\n\n"), b.subarray(0, nb)])); } finally { fs.closeSync(fd); }
      } else fs.copyFileSync(src, full);
      try { fs.utimesSync(full, st.atime, st.mtime); } catch {}
      done.push({ orig: src, name: target, size: st.size, mtime: Math.round(st.mtimeMs), cut, kind: d.kind || "log" });
    } catch (e) { done.push({ orig: src, name: "", size: 0, skipped: "couldn't be read: " + e.message }); }
  }
  return done;
}

/* ------------------------------------------------------------------ crash dumps (the Windows kind, which games run through Proton still write) */
function dump(file) {
  const b = fs.readFileSync(file); if (b.length < 32 || b.readUInt32LE(0) !== 0x504d444d) return { ok: false, error: "not a Windows crash dump" };
  const count = b.readUInt32LE(8), dirRva = b.readUInt32LE(12), prm = [], mods = []; let exAddr = 0n, exCode = 0, hasEx = false, modRva = 0;
  for (let i = 0; i < count && i < 200; i++) {
    const at = dirRva + i * 12; if (at + 12 > b.length) break; const type = b.readUInt32LE(at), rva = b.readUInt32LE(at + 8);
    if (type === 6 && rva + 8 + 152 <= b.length) { exCode = b.readUInt32LE(rva + 8); exAddr = b.readBigUInt64LE(rva + 24); const np = b.readUInt32LE(rva + 32); for (let k = 0; k < np && k < 4; k++) prm.push("0x" + b.readBigUInt64LE(rva + 40 + k * 8).toString(16).toUpperCase()); hasEx = true; }
    else if (type === 4) modRva = rva;
  }
  let module = "", modulePath = "", offset = 0n;
  if (modRva && modRva + 4 <= b.length) {
    const n = b.readUInt32LE(modRva);
    for (let i = 0; i < n && i < 2000; i++) {
      const at = modRva + 4 + i * 108; if (at + 108 > b.length) break;
      const base = b.readBigUInt64LE(at), size = BigInt(b.readUInt32LE(at + 8)), nameRva = b.readUInt32LE(at + 20);
      let name = ""; if (nameRva + 4 <= b.length) { const len = b.readUInt32LE(nameRva); if (len > 0 && len < 4000 && nameRva + 4 + len <= b.length) name = b.toString("utf16le", nameRva + 4, nameRva + 4 + len); }
      const leaf = name.replace(/^.*[\\/]/, ""); mods.push(leaf);
      if (hasEx && exAddr >= base && exAddr < base + size) { modulePath = name; module = leaf; offset = exAddr - base; }
    }
  }
  return { ok: true, hasException: hasEx, code: exCode, codeHex: "0x" + exCode.toString(16).toUpperCase().padStart(8, "0"), address: "0x" + exAddr.toString(16).toUpperCase(), module, modulePath, offset: "0x" + offset.toString(16).toUpperCase(), params: prm, modules: mods, size: b.length };
}

/* ------------------------------------------------------------------ the PC */
function osName() { const r = read("/etc/os-release"), m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(r); return m ? m[1] : "Linux"; }
const dmi = (f) => read("/sys/class/dmi/id/" + f).trim();
async function drives() {
  const out = await run("df", ["-B1", "--output=source,fstype,size,avail,target"], 4000), list = [], got = new Set();
  for (const l of out.split("\n").slice(1)) {
    const c = l.trim().split(/\s+/); if (c.length < 5) continue; const [src, type, size, avail] = c, target = c.slice(4).join(" ");
    if (!src.startsWith("/dev/") || /^(squashfs|tmpfs|devtmpfs|overlay|efivarfs|vfat|iso9660)$/.test(type) || /^\/(boot|snap|var\/lib\/(docker|snapd))(\/|$)/.test(target) || got.has(src)) continue;
    if (+size < 2 * 1073741824) continue;          // small system partitions (boot, firmware) aren't worth showing
    got.add(src); list.push({ name: target, label: target === "/" ? "System" : target === "/home" ? "Home" : "", free: +avail, total: +size });
  }
  return list;
}
function routes() { const r = {}; for (const l of read("/proc/net/route").split("\n").slice(1)) { const c = l.split("\t"); if (c.length > 3 && c[1] === "00000000" && c[2] !== "00000000") { const g = c[2].match(/../g).reverse().map((h) => parseInt(h, 16)).join("."); if (!r[c[0]]) r[c[0]] = g; } } return r; }
function nets() {
  const gw = routes(), ifs = os.networkInterfaces(), list = [];
  let names = []; try { names = fs.readdirSync("/sys/class/net"); } catch {}
  for (const n of names) {
    if (n === "lo" || /^(docker|veth|br-|virbr|vmnet|vbox|tun|tap|wg|tailscale|zt)/.test(n)) continue;
    const b = "/sys/class/net/" + n, up = read(b + "/operstate").trim() === "up", wifi = fs.existsSync(b + "/wireless") || fs.existsSync(b + "/phy80211"), sp = num(read(b + "/speed"));
    const ip = ((ifs[n] || []).find((a) => a.family === "IPv4") || {}).address || "";
    list.push({ name: n, desc: n, wifi, up, mbps: up && sp > 0 ? sp : 0, ip, gateway: gw[n] || "", rx: num(read(b + "/statistics/rx_bytes")), tx: num(read(b + "/statistics/tx_bytes")) });
  }
  return list;
}
async function sysinfo() {
  const m = mem(), cpu = (/^model name\s*:\s*(.+)$/m.exec(read("/proc/cpuinfo")) || [])[1] || "", gpus = [];
  if (G.smi === null) G.smi = which("nvidia-smi");
  if (G.smi) for (const l of (await run(G.smi, ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], 3000)).split("\n")) { const c = l.split(",").map((x) => x.trim()); if (c[0]) gpus.push({ name: c[0], driver: c[1] || "", driverDate: "", vramMB: Math.max(0, num(c[2])), provider: "NVIDIA" }); }
  if (!gpus.length) {
    const names = {}; const lspci = which("lspci"); if (lspci) for (const l of (await run(lspci, ["-mm"], 3000)).split("\n")) { const x = /^(\S+) "(?:VGA|3D|Display)[^"]*" "([^"]*)" "([^"]*)"/.exec(l); if (x) names[x[1]] = (x[2].replace(/ (Corporation|Corp\.|, Inc\.).*$/, "") + " " + x[3]).trim(); }
    try { for (const c of fs.readdirSync("/sys/class/drm")) { if (!/^card\d+$/.test(c)) continue; const d = "/sys/class/drm/" + c + "/device", ue = read(d + "/uevent"), drv = (/^DRIVER=(.+)$/m.exec(ue) || [])[1] || "", slot = ((/^PCI_SLOT_NAME=(.+)$/m.exec(ue) || [])[1] || "").replace(/^0000:/, "");
      const vr = num(read(d + "/mem_info_vram_total")); gpus.push({ name: names[slot] || (drv ? drv + " graphics" : "Graphics card"), driver: drv ? drv + " (kernel " + os.release() + ")" : "", driverDate: "", vramMB: vr > 0 ? Math.round(vr / 1048576) : 0, provider: drv }); } } catch {}
  }
  return { cpu: cpu.trim(), threads: CPUS, ramMB: Math.round(m.total / 1048576), commitLimitMB: Math.round(m.commitTotal / 1048576), pagefileMB: Math.round((m.commitTotal - m.total) / 1048576),
    os: osName(), osVersion: "kernel " + os.release(), osBuild: "", gpus, disks: (await drives()).map((d) => ({ name: d.name, freeGB: Math.round(d.free / 1073741824 * 10) / 10, totalGB: Math.round(d.total / 1073741824 * 10) / 10 })),
    screen: "", uptimeMin: Math.round(os.uptime() / 60), board: (dmi("board_vendor") + " " + dmi("board_name")).trim(), bios: dmi("bios_version"), biosDate: dmi("bios_date"), desktop: process.env.XDG_CURRENT_DESKTOP || "", session: process.env.XDG_SESSION_TYPE || "" };
}
const topPrev = new Map(); let topAt = 0;
async function pc(top) {
  const m = mem(), cpu = sysCpu(pcSlot); if (!watched.size) await gpuRead();
  const ns = nets(); let rx = 0, tx = 0; for (const n of ns) if (n.up && n.gateway) { rx += Math.max(0, n.rx); tx += Math.max(0, n.tx); }
  const r = { t: Date.now(), cpu, cores: CPUS, ramTotal: m.total, ramFree: m.free, commitTotal: m.commitTotal, commitFree: m.commitFree, gpu: G.use, vramMB: G.mem, vramTotalMB: G.memTotal, gpuFan: G.fan, gpuName: G.name, gpuTemp: G.temp, gpuPower: G.power,
    drives: await drives(), nets: ns.map((n) => ({ name: n.name, desc: n.desc, wifi: n.wifi, up: n.up, mbps: n.mbps, ip: n.ip, gateway: n.gateway })), rx, tx, upMs: os.uptime() * 1000 };
  if (top) {
    const now = Date.now(), dt = topAt ? (now - topAt) / 1000 : 0, rows = [], alive = new Set(); topAt = now;
    for (const pid of pids()) {
      const st = statOf(pid); if (!st) continue; alive.add(pid);
      const rss = (+(read("/proc/" + pid + "/statm").split(" ")[1]) || 0) * 4096; if (!rss) continue;          // kernel threads use no memory of their own
      const prev = topPrev.get(pid), c = prev !== undefined && dt > 0 ? Math.max(0, Math.round(((st.cpuTicks - prev) / TICK) / dt / CPUS * 1000) / 10) : 0; topPrev.set(pid, st.cpuTicks);
      rows.push({ name: st.comm, pid, cpu: c, mem: rss });
    }
    for (const p of topPrev.keys()) if (!alive.has(p)) topPrev.delete(p);
    r.topCpu = rows.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 6); r.topMem = rows.slice().sort((a, b) => b.mem - a.mem).slice(0, 6); r.procs = rows.length;
  }
  return r;
}
// Is the internet there? Answers from the router, from two addresses on the internet, and from the name server.
let pingBin = null;
function pingMs(host, timeout) {
  if (pingBin === null) pingBin = which("ping");
  if (pingBin) return run(pingBin, ["-n", "-c", "1", "-W", String(Math.max(1, Math.round(timeout / 1000))), host], timeout + 1500).then((out) => { const x = /time[=<]([\d.]+)\s*ms/.exec(out); return x ? Math.max(1, Math.round(+x[1])) : -1; });
  return new Promise((res) => {          // no ping program on this system: time a connection instead
    const t0 = Date.now(), s = net.connect({ host, port: 53, timeout }); let done = false; const end = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };
    s.on("connect", () => end(Math.max(1, Date.now() - t0))); s.on("timeout", () => end(-1)); s.on("error", (e) => end(e.code === "ECONNREFUSED" ? Math.max(1, Date.now() - t0) : -1));
  });
}
function dnsMs(server, name, timeout) {          // asked directly with a small question, so a remembered answer doesn't hide a name server that stopped
  return new Promise((res) => {
    const parts = []; for (const p of name.split(".")) { parts.push(Buffer.from([p.length]), Buffer.from(p, "ascii")); }
    const q = Buffer.concat([Buffer.from([0x5a, 0x7e, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...parts, Buffer.from([0, 0, 1, 0, 1])]), s = dgram.createSocket("udp4"), t0 = Date.now();
    let done = false; const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch {} res(v); }, t = setTimeout(() => end(-1), timeout);
    s.on("error", () => end(-1)); s.on("message", (a) => end(a.length >= 12 && a[0] === 0x5a && a[1] === 0x7e ? Math.max(1, Date.now() - t0) : -1));
    try { s.send(q, 53, server, (e) => { if (e) end(-1); }); } catch { end(-1); }
  });
}
async function netCheck(hosts, name) {
  const up = nets().find((n) => n.up && n.gateway), gw = up ? up.gateway : "";
  const dns = (/^nameserver\s+(\d+\.\d+\.\d+\.\d+)/m.exec(read("/etc/resolv.conf")) || [])[1] || "";
  const [gwMs, dMs, ...ps] = await Promise.all([gw ? pingMs(gw, 1000) : -1, dns ? dnsMs(dns, name || "example.com", 1800) : -1, ...hosts.map((h) => pingMs(h, 1500))]);
  return { t: Date.now(), link: !!up, adapter: up ? up.name : "", wifi: up ? up.wifi : false, mbps: up ? up.mbps : 0, gateway: gw, gatewayMs: gwMs, dns, dnsMs: dMs, pings: hosts.map((h, i) => ({ host: h, ms: ps[i] })) };
}
function modules(pid) {          // the libraries loaded in the game (overlays and mods show up here)
  const maps = read("/proc/" + pid + "/maps"); if (!maps) return { ok: false, error: "Linux doesn't allow looking at this program's libraries." };
  const set = new Set(); for (const l of maps.split("\n")) { const i = l.indexOf("/"); if (i > 0) { const f = l.slice(i); if (/\.(so(\.[\d.]+)?|dll|exe|drv)$/i.test(f)) set.add(f); } }
  return { ok: true, list: [...set] };
}
function verinfo(file) {          // a game's proper name: Steam writes it next to the library the game is in
  try {
    const st = fs.statSync(file); let product = "";
    const m = /^(.*\/steamapps)\/common\/([^/]+)/i.exec(file);
    if (m) for (const f of fs.readdirSync(m[1])) { if (!/^appmanifest_\d+\.acf$/.test(f)) continue; const t = read(path.join(m[1], f)); if ((/"installdir"\s+"([^"]*)"/.exec(t) || [])[1] === m[2]) { product = (/"name"\s+"([^"]*)"/.exec(t) || [])[1] || ""; break; } }
    return { ok: true, product, company: "", description: "", version: "", fileVersion: "", sizeMB: Math.round(st.size / 1048576 * 10) / 10, modified: Math.round(st.mtimeMs) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------------------------------------------------ a report as a .zip (no outside program needed) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipDir(dir, out) {
  const files = []; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(f, r); else if (e.isFile()) files.push([f, r]); } }; walk(dir, "");
  const fd = fs.openSync(out, "w"), central = []; let at = 0; const put = (b) => { fs.writeSync(fd, b); at += b.length; };
  try {
    for (const [f, rel] of files) {
      const data = fs.readFileSync(f); if (data.length > 0xfff00000) continue;
      const comp = zlib.deflateRawSync(data, { level: 6 }), name = Buffer.from(rel, "utf8"), crc = crc32(data), d = new Date(fs.statSync(f).mtime);
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name])); put(h); put(name); put(comp);
    }
    const start = at; for (const c of central) put(c);
    const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10); e.writeUInt32LE(at - start, 12); e.writeUInt32LE(start, 16); put(e);
  } finally { fs.closeSync(fd); }
  return fs.statSync(out).size;
}

/* ------------------------------------------------------------------ commands */
let kaExe = "", kaOn = false;
async function handle(c) {
  switch (c.cmd) {
    case "hello": return { ok: true, version: 1, pid: process.pid, system: "linux" };
    case "procs": return { ok: true, list: procs() };
    case "allprocs": { const set = new Set(); for (const pid of pids()) { const i = info(pid); if (i && i.name) set.add(i.name); } return { ok: true, list: [...set] }; }
    case "watch": watchNames = new Set((c.names || []).map((x) => String(x).toLowerCase())); ignoreNames = new Set((c.ignore || []).map((x) => String(x).toLowerCase())); autoGames = c.auto !== 0; interval = Math.max(1000, Math.min(10000, c.interval | 0 || 2000)); seen.clear(); looks.clear(); restart(); return { ok: true };
    case "attach": { const pid = c.pid | 0, ok = attach(pid, "picked"); if (ok) seen.add(pid); return ok ? { ok: true } : { ok: false, error: "That program couldn't be watched (it has ended, or it belongs to another user)." }; }
    case "detach": watched.delete(c.pid | 0); return { ok: true };
    case "events": return { ok: true, list: await events(+c.from || 0, +c.to || Date.now()) };
    case "scan": return { ok: true, result: scan(c.roots, (c.tokens || []).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 3), +c.from || 0, +c.to || Date.now()) };
    case "copy": return { ok: true, files: copyFiles(c.files, String(c.dest || ""), +c.maxBytes || 3e8, +c.tailBytes || 4e6) };
    case "dump": try { return dump(String(c.path || "")); } catch (e) { return { ok: false, error: e.message }; }
    case "sysinfo": return { ok: true, info: await sysinfo() };
    case "pc": return { ok: true, pc: await pc(!!c.top) };
    case "net": return { ok: true, net: await netCheck((c.hosts || []).map(String), String(c.name || "")) };
    case "runs": { const next = new Set((c.pids || []).map(Number).filter((x) => x > 1)); const added = [...next].some((p) => !runPids.has(p)); runPids = next; if (added) { seen.clear(); looks.clear(); } return { ok: true }; }
    case "keepalive": kaExe = String(c.exe || ""); kaOn = !!c.on; return { ok: true };
    case "modules": return modules(c.pid | 0);
    case "verinfo": return verinfo(String(c.path || ""));
    case "localdumps": return { ok: true, on: false, unsupported: true };          // Windows only: on Linux systemd keeps core dumps by itself
    case "zip": try { try { fs.unlinkSync(String(c.out)); } catch {} return { ok: true, size: zipDir(String(c.dir), String(c.out)) }; } catch (e) { return { ok: false, error: e.message }; }
    default: return { ok: false, error: "unknown command" };
  }
}
let timer = null;
function restart() { if (timer) clearInterval(timer); timer = setInterval(() => { try { tick(); } catch (e) { send({ ev: "error", message: e.message }); } }, interval); }

if (require.main === module) {
  if (process.argv[2] === "--dump") { console.log(JSON.stringify(dump(process.argv[3]))); process.exit(0); }
  process.on("uncaughtException", (e) => send({ ev: "error", message: "fatal: " + (e && e.stack ? e.stack : e) }));
  restart();
  let buf = "", quit = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let c; try { c = JSON.parse(line); } catch { continue; }
      if (c.cmd === "quit") { quit = true; kaOn = false; process.exit(0); }
      handle(c).then((r) => { r.re = c.id; send(r); }, (e) => send({ re: c.id, ok: false, error: e.message }));
    }
  });
  // Keep alive: the line to the app closed without a "quit" (it was ended from outside, or crashed): open it again, hidden.
  process.stdin.on("end", () => {
    if (!quit && kaOn && kaExe && fs.existsSync(kaExe)) setTimeout(() => { try { spawn(kaExe, ["--hidden", "--revived=ended"], { detached: true, stdio: "ignore" }).unref(); } catch {} process.exit(0); }, 2500);
    else process.exit(0);
  });
}
module.exports = { info, looksLikeGame, events, scan, copyFiles, dump, zipDir, sysinfo, pc, netCheck, handle };
