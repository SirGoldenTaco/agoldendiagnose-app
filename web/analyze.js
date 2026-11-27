/* aGoldenDiagnose: reading a report. Given everything that was collected when a game ended, say in plain words what
 * most likely happened and what to try. Pure functions (no window, no files): the app's page uses them to show a
 * report, and the Windows side uses LOG_PATTERNS while it collects the logs. */
"use strict";
(function (root) {
  /* What Windows' exit codes mean. [short name, what it means in plain words] */
  const CODES = {
    0xC0000005: ["Access violation", "the game (or something loaded inside it) touched memory it wasn't allowed to"],
    0xC0000409: ["Fail-fast / stack buffer overrun", "the game stopped itself on purpose after detecting something it couldn't recover from"],
    0xC0000602: ["Fail-fast exception", "the game stopped itself on purpose after detecting something it couldn't recover from"],
    0xC0000374: ["Heap corruption", "the game's memory was damaged before the crash (a bug, a mod, or unstable RAM)"],
    0xC00000FD: ["Stack overflow", "a part of the game called itself endlessly until it ran out of room"],
    0xC000001D: ["Illegal instruction", "the game ran an instruction this processor rejected (corrupted files or an unstable overclock)"],
    0xC0000096: ["Privileged instruction", "the game ran an instruction it isn't allowed to (corrupted files or an unstable overclock)"],
    0xC0000094: ["Division by zero", "a bug in the game's own code"],
    0xC000008E: ["Division by zero", "a bug in the game's own code"],
    0xC0000135: ["A needed file is missing", "a DLL the game needs wasn't found (missing Visual C++ / DirectX runtime, or game files)"],
    0xC0000139: ["Wrong version of a file", "a DLL the game needs is the wrong version (outdated runtime, or mixed-up game files)"],
    0xC0000142: ["A file failed to start", "a DLL the game needs couldn't start (often an overlay, antivirus, or a broken runtime)"],
    0xC000007B: ["Bad program file", "a DLL is damaged or is the wrong kind (32-bit / 64-bit mix-up, broken runtime)"],
    0xC0000017: ["Out of memory", "Windows had no memory left to give the game"],
    0xC000012D: ["Out of virtual memory", "Windows ran out of memory + page file (the page file is too small or the drive is full)"],
    0xC000009A: ["Out of system resources", "Windows ran out of a system resource"],
    0xC0000006: ["Couldn't read from the drive", "Windows failed to read part of the game from the drive (drive problem, or damaged files)"],
    0xE06D7363: ["Unhandled C++ exception", "the game hit an error it had no code to deal with"],
    0xE0434352: ["Unhandled .NET exception", "the game hit an error it had no code to deal with"],
    0x80000003: ["Breakpoint / assert", "a safety check inside the game failed and stopped it"],
    0xC0000420: ["Assertion failure", "a safety check inside the game failed and stopped it"],
    0x40000015: ["The game aborted", "the game called its emergency stop"],
    0xC000041D: ["Error inside a Windows callback", "the game crashed while Windows was calling into it"],
    0xC000013A: ["Closed from its console", "the game's console window was closed or Ctrl+C was pressed"],
    0x887A0005: ["Graphics device removed", "the graphics card stopped answering (driver crash, overheating, or too much demanded of it)"],
    0x887A0006: ["Graphics device hung", "the graphics card took too long and Windows reset it"],
    0x887A0007: ["Graphics device reset", "the graphics driver was reset while the game was drawing"],
  };
  const hex = (n) => "0x" + (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const codeInfo = (n) => CODES[Number(n) >>> 0] || null;
  /** Is this exit code a crash by itself? (Windows error codes start at 0x80000000; games' own codes are small.) */
  const crashCode = (n) => { n = Number(n) >>> 0; return n >= 0x80000000 && n !== 0xC000013A && n !== 0xFFFFFFFF; };

  /* Which kind of file the crash happened in. First match wins. */
  const MODULES = [
    [/^lib(nvidia|glx_nvidia|egl_nvidia|nvoptix)|^nvidia/i, "gpu", "the NVIDIA graphics driver"],
    [/radeonsi|libvulkan_(radeon|intel|lvp)|libgallium|iris_dri|i965_dri|libgl(x_mesa|api)|libdrm/i, "gpu", "the Mesa graphics driver"],
    [/^(vkd3d|wined3d|winevulkan|libvulkan\.so|libdxvk|libvkd3d)/i, "dx", "DirectX / the graphics layer"],
    [/mangohud|vkbasalt|libobs|gamescope/i, "overlay", "an overlay or recording tool"],
    [/^(libc\.so|libc-|libpthread|ld-linux|libstdc\+\+|libm\.so|libgcc_s|libdl\.so)/i, "windows", "a system library (usually just where the game's own mistake surfaced)"],
    [/^(nv|nvoglv|nvwgf2um|nvppex|nvd3dum|nvlddmkm|nvapi|nvcuda|nvngx|nvrtum|nvldumd)/i, "gpu", "the NVIDIA graphics driver"],
    [/^(ati|amd|atid|aticf|amdxc|amdvlk|atio6|amdxx|amfrt)/i, "gpu", "the AMD graphics driver"],
    [/^(ig[0-9dx]|igd|igc|igxe|igvk|intelocl)/i, "gpu", "the Intel graphics driver"],
    [/^(d3d(9|10|11|12)|d3d12core|dxgi|dxcore|d3dcompiler|dxil|d3dscache|vulkan-1|opengl32|dxvk|d3d8)/i, "dx", "DirectX / the graphics layer"],
    [/gameoverlayrenderer|steamoverlay/i, "overlay", "the Steam overlay"],
    [/discord(hook|overlay)|discord_/i, "overlay", "the Discord overlay"],
    [/rtss|rivatuner|msiafterburner/i, "overlay", "RivaTuner / MSI Afterburner's overlay"],
    [/eosovh|epicoverlay|eos-overlay/i, "overlay", "the Epic Games overlay"],
    [/nvspcap|nvcamera|nvsdk_ngx|nvshare|nvoverlay|nvcontainer/i, "overlay", "NVIDIA's overlay / ShadowPlay"],
    [/graphics-hook|obs-|medal|owclient|overwolf|ow-graphics|action_x64|bandicam|fraps|mirillis|xsplit|playclaw/i, "overlay", "a recording / overlay tool"],
    [/reshade|specialk|sweetfx|enb(series)?|dinput8|winmm|version|dsound|xinput1_3|d3d11|dxgi/i, "mod", "a mod loader or graphics add-on (a DLL placed in the game's folder)"],
    [/easyanticheat|eac_|beclient|battleye|vgk|vanguard|xigncode|nprotect|faceit|esea|punkbuster|denuvo/i, "anticheat", "the anti-cheat / protection"],
    [/nahimic|sonic(studio|suite)|a-volute|audiodevprops|ss2|waves|maxxaudio|dolby|dts|x-?fi|sbz|fmod|wwise|xaudio|audioses|mmdevapi|openal/i, "audio", "audio software or the sound engine"],
    [/^(clr|coreclr|clrjit|mscor|mono-2|mono\.|monobleed|il2cpp)/i, "runtime", "the .NET / Mono runtime the game runs on"],
    [/^(unityplayer|gameassembly)/i, "engine", "the Unity engine"],
    [/^(ntdll|kernelbase|kernel32|ucrtbase|vcruntime|msvcp|msvcr|user32|win32u|combase|ole32|rpcrt4|sechost|gdi32|ws2_32|mswsock)/i, "windows", "a Windows system file (usually just where the game's own mistake surfaced)"],
    [/bink|mfplat|mfreadwrite|msmpeg|avcodec|avformat|cri_|wmvdecod|quartz/i, "video", "the video player (intro or cutscene movies)"],
    [/steam_api|steamclient|galaxy|uplay|upc_|eossdk|origin|ea(core|anticheat)|socialclub|bnet/i, "launcher", "the launcher's library (Steam / Epic / Ubisoft / EA…)"],
    [/^(bd|avast|avg|kaspersky|kl|eset|mbam|sbie|comodo|sophos|norton|symantec|mcafee|trend|cylance|sentinel|crowd|bitdefender|atc|hmpalert)/i, "antivirus", "security software injected into the game"],
    [/(aura|icue|corsair|razer|synapse|lghub|logitech|steelseries|wallpaper|lightingservice|asus|armoury|msi\.|dragon|nzxt)/i, "addon", "RGB / peripheral software injected into the game"],
  ];
  function moduleKind(name, gameExe, gameDir, modulePath) {
    const n = String(name || "").toLowerCase(); if (!n) return null;
    const inGame = !!gameDir && String(modulePath || "").toLowerCase().startsWith(String(gameDir).toLowerCase());
    if (gameExe && n === String(gameExe).toLowerCase()) return { kind: "game", what: "the game's own program" };
    for (const [re, kind, what] of MODULES) { if (!re.test(n)) continue; if (kind === "mod" && modulePath && !inGame) continue; return { kind, what }; }
    if (inGame) return { kind: "game", what: "one of the game's own files" };
    return { kind: "other", what: "a file that isn't part of the game" };
  }

  /* Lines worth showing from the game's own logs. [tag, pattern] */
  const LOG_PATTERNS = [
    ["crash", /wine: Unhandled (page fault|exception|illegal instruction|stack overflow|privileged instruction)|Unhandled page fault on|err:seh:|\(core dumped\)|Segmentation fault|Aborted \(core|terminate called after throwing/i],
    ["gpu", /vkd3d[^\n]{0,80}(device (removed|lost)|DEVICE_REMOVED)|dxvk[^\n]{0,80}(DEVICE_LOST|device lost)|ring (gfx|comp)[^\n]{0,20}timeout|GPU (hang|reset)/i],
    ["vram", /out of video memory|out of vram|OUT_OF_DEVICE_MEMORY|OUTOFVIDEOMEMORY|video memory (has been )?exhausted|not enough (video|graphics) memory|ran out of GPU memory/i],
    ["gpu", /DXGI_ERROR_DEVICE_(REMOVED|HUNG|RESET)|device (was |has been )?removed|D3D device (being |was )?lost|GPU (crashed|hung|has crashed)|0x887A000[567]|VK_ERROR_DEVICE_LOST|nvlddmkm|video driver (crashed|stopped)|display driver (stopped|has stopped|failed)|GetDeviceRemovedReason/i],
    ["oom", /out of memory|E_OUTOFMEMORY|std::bad_alloc|OutOfMemoryException|ran out of memory|0x8007000E|OUT_OF_HOST_MEMORY|could ?n[o']t allocate|failed to allocate|allocation of \d+ bytes failed|not enough memory|paging file is too small/i],
    ["crash", /EXCEPTION_[A-Z_]+|access violation|unhandled exception|fatal error|LowLevelFatalError|assertion failed|assert(ion)? failed|segmentation fault|SIGSEGV|SIGABRT|stack overflow|crash (report|dump|detected|handler)|=+ ?crash|pure virtual function call|terminate called|has stopped working|critical error|engine (crash|exit requested)|Crash!!!|unreal engine is exiting|ErrorMessage:|Exception was unhandled/i],
    ["files", /corrupt(ed|ion)?\b|checksum (mismatch|failed)|failed to (open|load|read|mount) [^\n]{0,40}(pak|file|asset|bundle|archive)|pak (chunk|file)[^\n]{0,40}(error|corrupt|fail)|missing (file|dll|asset)|could ?n[o']t find (file|asset|dll)|file is damaged|decompression (error|failed)|CRC (error|mismatch)/i],
    ["anticheat", /(easyanticheat|battleye|anti-?cheat|vanguard|integrity)[^\n]{0,80}(error|fail|violation|kick|blocked|denied|not (running|installed|loaded))|game security violation|untrusted system file/i],
    ["driver", /driver[^\n]{0,60}(outdated|too old|out of date|not supported|update your)|unsupported (gpu|graphics card|video card)|shader compil[^\n]{0,40}(fail|error)|feature level[^\n]{0,40}(not supported|required)|requires directx/i],
    ["net", /connection (to [^\n]{0,30})?(lost|timed out|closed by)|disconnected from (the )?(server|host)|lost connection|network error|kicked from/i],
  ];
  const TAG_NAME = { vram: "Video memory", gpu: "Graphics card", oom: "Memory", crash: "Crash", files: "Game files", anticheat: "Anti-cheat", driver: "Driver / hardware support", net: "Connection" };
  /** The lines of a log that matter: up to `max` of them, looking at its last `tail` lines. [{n, text, tag}] */
  function scanLog(text, max, tail) {
    const lines = String(text).split(/\r?\n/), from = Math.max(0, lines.length - (tail || 4000)), out = [];
    for (let i = lines.length - 1; i >= from && out.length < (max || 12); i--) {
      const l = lines[i]; if (l.length < 6 || l.length > 4000) continue;
      for (const [tag, re] of LOG_PATTERNS) if (re.test(l)) { out.push({ n: i + 1, text: l.trim().slice(0, 400), tag }); break; }
    }
    return out.reverse();
  }

  const fmtMB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + " GB" : Math.round(mb) + " MB");
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + " s" : s < 3600 ? Math.floor(s / 60) + " min " + (s % 60 ? (s % 60) + " s" : "") : Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min"; };
  const near = (r, t, before, after) => t >= r.end - before && t <= r.end + after;

  /** The same sentences for a Linux PC: what Windows calls something, said the Linux way. Used for a report made on
   *  Linux, for the PC tab's lines, and for the screens themselves. */
  const LINUX_WORDS = [[/Start with Windows/g, "Start when I sign in"], [/start with Windows/g, "start when you sign in"], [/sign in to Windows/g, "sign in"], [/started with Windows/g, "started at sign-in"], [/A Windows notification/g, "A desktop notification"],
    [/[Bb]lue[- ]screen memory dump/g, "kernel crash dump"], [/Blue screen/g, "Kernel panic"], [/blue screen/g, "kernel panic"],
    [/Windows events/g, "System log"], [/Windows'(?: own)? (?:event log|record|log)/g, "the system log"], [/in its event log/g, "in its log"], [/Task Manager > Startup apps/g, "your desktop's startup settings"], [/Task Manager/g, "the system monitor"], [/next to the clock/g, "in the system tray"],
    [/Add a game's \.exe/g, "Add a game's program"], [/the game's \.exe file/g, "the game's program file"], [/PowerShell/g, "the system's own tools"], [/WHEA event\(s\)/g, "hardware-error line(s)"], [/Windows Security/g, "Security"],
    [/\bWindows('s)? (system file|crash dump|callback|game|app\b)/g, "\u0001$1 $2"], [/\bWindows'/g, "the system's"], [/\bWindows\b/g, "the system"], [/\u0001/g, "Windows"], [/the page file/g, "swap"], [/page file/g, "swap"], [/ space on C: for updates/g, " free space for updates"],
    [/a Steam, Epic, GOG, Xbox, EA, Ubisoft, Rockstar or Riot games folder/g, "a Steam, Heroic, Lutris, Bottles, GOG or itch games folder"]];
  function linuxWords(t) {
    t = String(t == null ? "" : t); if (!/\bWindows|[Bb]lue[- ]screen|Task Manager|next to the clock|PowerShell|WHEA|\.exe|page file|on C:|Rockstar or Riot/.test(t)) return t;
    for (const [re, to] of LINUX_WORDS) t = t.replace(re, to);
    return t.replace(/(^|[.!?:]\s+|\n)the system/g, "$1The system");
  }
  const WINDOWS_ONLY_TIP = /Visual C\+\+|DirectX (End-User )?[Rr]untime|\bDDU\b|page file|chkdsk|Media Feature Pack|Windows Update|Fast Startup|Nahimic|antivirus quarantine|security software's exclusions/;

  /** The reading of one report: { kind, title, why, findings: [{sev, title, text}], tips: [text], facts: [[label, value]] } */
  function analyze(r) {
    const ev = r.events || [], files = r.files || [], st = r.stats || {}, sys = r.system || {}, hits = r.logHits || [], dumps = (r.dumps || []).filter((d) => d && d.ok && d.hasException);
    const exe = String((r.game && r.game.exe) || "").toLowerCase(), dir = (r.game && r.game.dir) || "";
    const code = r.exit ? Number(r.exit.code) >>> 0 : 0, info = codeInfo(code), dur = (r.end || 0) - (r.start || 0);
    const mine = (e) => (e.data || []).concat([e.message || ""]).some((d) => exe && String(d).toLowerCase().includes(exe));
    const appErr = ev.find((e) => e.provider === "Application Error" && e.id === 1000 && mine(e));
    const appHang = ev.find((e) => e.provider === "Application Hang" && mine(e));
    const gpuEv = ev.filter((e) => (e.provider === "Display" && e.id === 4101) || (/^(nvlddmkm|amdkmdag|amdwddmg|igfx)/i.test(e.provider) && e.level <= 2) || (e.provider === "Microsoft-Windows-DxgKrnl" && e.level <= 2)).filter((e) => near(r, e.t, 120000, 30000));
    const whea = ev.filter((e) => e.provider === "Microsoft-Windows-WHEA-Logger");
    const bug = ev.find((e) => e.provider === "BugCheck" || (e.provider === "Microsoft-Windows-WER-SystemErrorReporting" && e.id === 1001));
    const power = ev.find((e) => e.provider === "Microsoft-Windows-Kernel-Power" && e.id === 41);
    const exhaust = ev.find((e) => e.provider === "Microsoft-Windows-Resource-Exhaustion-Detector" && near(r, e.t, 600000, 60000));
    const diskEv = ev.filter((e) => /^(disk|Ntfs|volmgr|nvme|stornvme)$/i.test(e.provider) && e.level <= 2);
    const sxs = ev.find((e) => e.provider === "SideBySide" && mine(e));
    const dotnet = ev.find((e) => e.provider === ".NET Runtime" && e.level <= 2 && mine(e));
    const tag = (t) => hits.filter((h) => h.tag === t);
    // where it crashed: Windows' own record first, then a crash dump
    let mod = null, modName = "", exCode = 0;
    if (appErr && appErr.data && appErr.data.length >= 8) { modName = appErr.data[3] || ""; exCode = parseInt(appErr.data[6], 16) >>> 0; mod = moduleKind(modName, exe, dir, appErr.data[11] || ""); }
    if (!mod && dumps[0]) { modName = dumps[0].module; exCode = Number(dumps[0].code) >>> 0; mod = moduleKind(modName, exe, dir, dumps[0].modulePath); }
    const errCode = exCode || (crashCode(code) ? code : 0), errInfo = codeInfo(errCode);
    const gpu0 = (sys.gpus || []).slice().sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0] || null;
    const vramFull = gpu0 && gpu0.vramMB > 0 && st.lastSysVram > 0 && st.lastSysVram >= gpu0.vramMB * 0.95;
    const ramTight = (st.lastRamFree >= 0 && st.lastRamFree < 400) || st.lastCommit >= 97;

    const F = [], T = [], tip = (t) => { if (!T.includes(t)) T.push(t); }, find = (sev, title, text) => F.push({ sev, title, text });
    const linux = r.platform === "linux", noCode = !!(r.exit && r.exit.unknown);          // Linux doesn't tell an outside program a game's exit code
    let kind = "normal", title = "Closed normally", why = noCode ? "The game ended, and neither the system log nor the game's own files show a crash." : "The game ended with code 0 and Windows recorded no error.";

    if (r.exit && r.exit.how === "lost") {
      if (bug || power) { kind = "pc"; title = bug ? "The whole PC crashed (blue screen)" : "The PC shut off or restarted without warning"; why = bug ? "Windows recorded a system crash while the game was running" + (bug.message ? ": " + bug.message.split("\n")[0].slice(0, 200) : ".") : "Windows recorded that it wasn't shut down properly (power loss, hard reset, or a freeze you had to cut power on)."; tip("A whole-PC crash is almost never the game's own fault: suspect drivers, heat, the power supply, or an unstable overclock / memory profile (XMP/EXPO)."); tip("Update the graphics driver and the motherboard BIOS, and test with the memory profile turned off."); }
      else { kind = "unknown"; title = "Watching stopped before the game ended"; why = "aGoldenDiagnose was closed (or the PC was restarted normally) while the game was still running, so how it ended isn't known."; }
    } else if (gpuEv.length || tag("gpu").length || (errCode >= 0x887A0005 && errCode <= 0x887A0007) || (mod && mod.kind === "gpu")) {
      kind = "gpu"; title = "The graphics card or its driver stopped answering";
      why = gpuEv.length ? (r.platform === "linux" ? "The system log recorded the graphics driver failing right when the game ended: “" + String(gpuEv[0].message || "").replace(/\s+/g, " ").slice(0, 160) + "”" : "Windows recorded the graphics driver failing right when the game ended (" + gpuEv[0].provider + " event " + gpuEv[0].id + ").") : mod && mod.kind === "gpu" ? "The crash happened inside " + mod.what + " (" + modName + ")." : tag("gpu").length ? "The game's own log says the graphics device was lost: “" + tag("gpu").slice(-1)[0].text.slice(0, 160) + "”" : "The game ended with a graphics-device error (" + hex(errCode) + ").";
      if (vramFull) { why += " Video memory was full at that moment (" + fmtMB(st.lastSysVram) + " of " + fmtMB(gpu0.vramMB) + ")."; tip("Lower texture quality, resolution or ray tracing: the card's memory was full."); }
      tip("Update the graphics driver; if it started after a driver update, go back to the previous one (a clean install with DDU helps).");
      tip("Remove any GPU overclock or undervolt, and check temperatures" + (st.maxGpuTemp > 0 ? " (the card peaked at " + Math.round(st.maxGpuTemp) + " °C this session)." : "."));
      tip("Cap the frame rate and turn off overlays (Discord, Steam, GeForce) to see if it stops.");
    } else if (tag("vram").length || (vramFull && (crashCode(code) || appErr))) {
      kind = "vram"; title = "The game ran out of video memory";
      why = tag("vram").length ? "The game's own log says so: “" + tag("vram").slice(-1)[0].text.slice(0, 160) + "”" : "Video memory was full when it crashed (" + fmtMB(st.lastSysVram) + " of " + fmtMB(gpu0.vramMB) + ").";
      tip("Lower texture quality first, then resolution / ray tracing / frame generation."); tip("Close other programs that use the graphics card (browsers with video, a second game, recording tools).");
    } else if (errCode === 0xC0000017 || errCode === 0xC000012D || exhaust || (tag("oom").length && (crashCode(code) || appErr || code !== 0)) || (ramTight && (crashCode(code) || appErr))) {
      kind = "oom"; title = "The PC ran out of memory";
      why = exhaust ? "Windows recorded that it was running out of memory when the game ended." : tag("oom").length ? "The game's own log says so: “" + tag("oom").slice(-1)[0].text.slice(0, 160) + "”" : ramTight ? "Memory was almost full when it crashed (" + (st.lastRamFree >= 0 ? fmtMB(st.lastRamFree) + " free" : "") + (st.lastCommit >= 0 ? ", " + Math.round(st.lastCommit) + "% of memory + page file committed" : "") + ")." : "The exit code means Windows had no memory left to give (" + hex(errCode) + ").";
      if (st.peakPm) why += " The game itself was using " + fmtMB(st.lastPm || st.peakPm) + ".";
      tip("Close other programs before playing (browsers are the usual culprit).");
      tip("Let Windows manage the page file (System > About > Advanced system settings > Performance > Advanced > Virtual memory: “Automatically manage”), and keep free space on that drive.");
      if (st.peakPm && sys.ramMB && st.peakPm > sys.ramMB * 0.7) tip("The game alone used most of the PC's memory: lower texture / world-detail settings, or it may be leaking memory (restart it every few hours).");
    } else if (appHang || (r.exit && r.exit.hungMs >= 5000)) {
      kind = "hang"; title = "The game froze (stopped responding)";
      why = appHang ? "Windows recorded the game as not responding and closed it." : "Its window had stopped responding for " + fmtDur(r.exit.hungMs) + " when it ended.";
      if (st.lastGpu >= 0 && st.lastGpu < 5 && st.lastCpu >= 0 && st.lastCpu < 3) tip("While frozen it used almost no CPU or GPU: it was waiting on something (a drive, the network, or a deadlock in the game).");
      else if (st.lastCpu > 15) tip("While frozen it was still working hard on the CPU: it may have been loading or compiling shaders. Next time, give it a minute before closing it.");
      tip("Check the drive the game is on (a slow or failing drive causes long freezes), and verify the game's files.");
    } else if (appErr || dumps.length || crashCode(code)) {
      kind = "crash"; title = "The game crashed";
      const what = errInfo ? errInfo[0] + " (" + hex(errCode) + "): " + errInfo[1] : errCode ? "error " + hex(errCode) : "Windows recorded a crash";
      why = what + "." + (mod ? " It happened inside " + mod.what + (modName ? " (" + modName + ")" : "") + "." : "");
      if (mod) {
        if (mod.kind === "overlay") tip("Turn that overlay off for this game: the crash happened inside it.");
        else if (mod.kind === "mod") tip("Remove the mod loader / graphics add-on from the game's folder (ReShade, ENB, a wrapper DLL) and try again.");
        else if (mod.kind === "anticheat") tip("Repair the anti-cheat (its installer is in the game's folder) and make sure no overlay or tool is being blocked by it.");
        else if (mod.kind === "audio") tip("Disable audio enhancement software (Nahimic / Sonic Studio / spatial sound) or update the audio driver: the crash happened in audio code.");
        else if (mod.kind === "antivirus") tip("Add the game's folder to your security software's exclusions: the crash happened inside its injected file.");
        else if (mod.kind === "addon") tip("Close RGB / peripheral software while playing: one of its files inside the game crashed.");
        else if (mod.kind === "video") tip("The crash is in the video player: install the Media Feature Pack / codecs, or skip the intro movies.");
        else if (mod.kind === "launcher") tip("Restart the launcher (Steam / Epic…) and verify the game's files.");
        else if (mod.kind === "dx") tip("Update the graphics driver and DirectX runtime; try the game's other renderer (DX11 / DX12 / Vulkan) if it has one.");
        else if (mod.kind === "runtime") tip("Repair the .NET / Visual C++ runtimes and verify the game's files.");
      }
      if (errCode === 0xC0000135 || errCode === 0xC0000139 || errCode === 0xC000007B || errCode === 0xC0000142 || sxs) tip("Install or repair the Visual C++ Redistributables (2015-2022, x64 and x86) and DirectX End-User Runtime, then verify the game's files.");
      if (errCode === 0xC0000006) tip("Check the drive the game is on (chkdsk, SMART health) and verify the game's files: Windows couldn't read part of the game.");
      if (errCode === 0xC000001D || errCode === 0xC0000096 || errCode === 0xC0000374 || whea.length) tip("Rule out unstable hardware: turn off CPU / memory overclocks (XMP/EXPO, undervolts) for a test.");
      if (!mod || mod.kind === "game" || mod.kind === "windows" || mod.kind === "engine" || mod.kind === "other") { tip("Verify the game's files in its launcher, and remove mods for a test."); tip("Turn off overlays and background tools, then update the graphics driver."); tip("If it keeps crashing the same way, send this report to the game's support: the crash is most likely a bug on their side."); }
    } else if (code !== 0) {
      kind = "error"; title = "The game ended with an error code";
      why = "It closed with code " + code + (code > 255 ? " (" + hex(code) + ")" : "") + " and Windows recorded no crash. " + (code === 1 ? "Code 1 is also what you get when a program is ended from Task Manager or closed by its launcher." : code === 3 ? "Code 3 usually means the game called its emergency stop (abort)." : "That is the game's own code: it decided to stop.") + (tag("crash").length ? " Its log has an error near the end: “" + tag("crash").slice(-1)[0].text.slice(0, 160) + "”" : "");
      if (tag("anticheat").length) tip("The anti-cheat reported a problem (see the log lines): repair it and close tools it may object to.");
      if (tag("net").length) tip("The log shows the connection dropping just before it ended.");
      tip("Look at the last lines of the game's log in this report: games usually write why they stopped.");
    }
    // The game's own crash reporter caught it: Windows saw a clean exit (code 0, no error event), but the game's log says otherwise.
    const loud = hits.filter((h) => h.tag === "crash" && /unhandled exception|fatal error|LowLevelFatalError|access violation|EXCEPTION_ACCESS_VIOLATION|assert(ion)? failed|crash (dump|detected)|segmentation fault|pure virtual function/i.test(h.text || ""));
    if (kind === "normal" && (r.crashFiles || []).length) {
      kind = "crash"; title = "The game crashed (its own crash reporter caught it)";
      why = "Windows saw the game close without an error, but the game left crash files behind during this session: " + r.crashFiles.slice(0, 4).join(", ") + ".";
      find("bad", "Crash files were written", "Collected in the Files tab: " + r.crashFiles.join(", "));
      tip("Verify the game's files in its launcher, and remove mods for a test."); tip("Turn off overlays and background tools, then update the graphics driver.");
    }
    if (kind === "normal" && loud.length) {
      kind = "crash"; title = "The game crashed (its own crash reporter caught it)";
      why = "Windows saw the game close without an error, but the game's log ends with a crash: " + String(loud[loud.length - 1].text).slice(0, 220);
      find("bad", "Crash written in the game's log", loud.slice(-3).map((h) => (h.file ? h.file + ": " : "") + h.text).join("\n"));
      tip("Verify the game's files in its launcher, and remove mods for a test."); tip("Turn off overlays and background tools, then update the graphics driver.");
    }
    // It closed by itself seconds after starting, with no error code: that isn't someone playing and quitting, it is a game that
    // couldn't start (and showed a message, or nothing at all).
    const ran = (r.end || 0) - (r.start || 0);
    if (kind === "normal" && ran > 0 && ran < 45000 && !(r.exit && r.exit.how === "lost")) {
      kind = "start"; title = "The game closed by itself right after starting";
      why = "It ran for " + Math.max(1, Math.round(ran / 1000)) + " seconds and then closed " + (noCode ? "" : "without an error code and ") + "without Windows recording a crash. A game that does this couldn't start properly: it stopped itself (sometimes after a message box, sometimes with nothing on screen).";
      tip("If a message appeared before it closed, that message is the answer: search for its exact words (see Fixes from the web above).");
      tip("Start the launcher the game needs first (Steam, EA app, Epic…) and make sure you are signed in; many games close at once without it.");
      tip("Verify or repair the game's files. If the game came from somewhere other than a store, check your antivirus quarantine: a removed file makes a game close like this.");
      tip("Install or repair the Visual C++ redistributables and the DirectX runtime, then update the graphics driver.");
      tip("Close overlays and tools that hook into games (RivaTuner, ReShade, recording overlays) for one test.");
      if ((r.others || []).length) find("info", "Running at the same time", "Programs known to hook into games were running: " + r.others.slice(0, 8).map((o) => o.name || o).join(", ") + ".");
    }
    if (kind === "normal" && (tag("crash").length || tag("gpu").length)) find("warn", "The game's log has errors anyway", "It closed with code 0, but its log mentions " + tag("crash").concat(tag("gpu")).length + " error line(s). See the Logs tab.");

    /* things worth knowing whatever the verdict */
    if (dur > 0 && dur < 90000 && kind !== "normal" && kind !== "unknown") { find("warn", "It ended " + fmtDur(dur) + " after starting", "A crash at startup usually means damaged or missing files, a missing runtime, or something blocking the game (antivirus, anti-cheat, an overlay)."); tip("Verify the game's files and restart the PC; if it still stops at startup, reinstall the Visual C++ runtimes."); }
    if (whea.length) find("bad", "Windows recorded hardware errors", whea.length + " WHEA event(s) this session: the processor, memory or a PCIe device reported a fault. That points to unstable hardware (overclock, memory profile, heat, or a failing part), not to the game.");
    if (diskEv.length) { find("bad", "Windows recorded drive errors", diskEv.length + " disk / file-system error event(s) this session (" + [...new Set(diskEv.map((e) => e.provider))].join(", ") + "). A failing or badly connected drive causes crashes and freezes."); tip("Check that drive's health (SMART) and cable, and back up what matters on it."); }
    if (st.maxGpuTemp >= 87) { find("warn", "The graphics card ran hot", "It peaked at " + Math.round(st.maxGpuTemp) + " °C. Above about 85 °C cards throttle and can become unstable."); tip("Clean the PC's dust filters and fans, and check the case airflow."); }
    if (vramFull && kind !== "vram" && kind !== "gpu") find("warn", "Video memory was full", fmtMB(st.lastSysVram) + " of " + fmtMB(gpu0.vramMB) + " in use at the end. Lower texture quality if you see stutter or crashes.");
    if (ramTight && kind !== "oom") find("warn", "Memory was almost full", (st.lastRamFree >= 0 ? fmtMB(st.lastRamFree) + " of RAM free" : "") + (st.lastCommit >= 0 ? " · " + Math.round(st.lastCommit) + "% committed" : "") + " at the end.");
    if (st.growMBh > 300 && dur > 20 * 60000) find("info", "The game's memory kept growing", "About " + fmtMB(st.growMBh) + " more every hour over this session (" + fmtMB(st.firstPm || 0) + " → " + fmtMB(st.lastPm || 0) + "). If it crashes after long sessions, that is a memory leak in the game: restarting it now and then avoids it.");
    const home = linux ? (sys.disks || []).filter((d) => d.name === "/" || (dir && (dir + "/").startsWith(d.name.replace(/\/$/, "") + "/"))).sort((a, b) => b.name.length - a.name.length).slice(0, 1).concat((sys.disks || []).filter((d) => d.name === "/")) : null;
    for (const d of linux ? [...new Set(home)] : sys.disks || []) if (d.freeGB < 6 && (linux || d.name[0] === "C" || (dir && dir[0].toUpperCase() === d.name[0]))) { find("warn", "Drive " + d.name + " is almost full", d.freeGB + " GB free. Windows and games need room for the page file, shader caches and saves."); tip("Free some space on " + d.name); }
    if (gpu0 && gpu0.driverDate) { const m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(gpu0.driverDate); if (m) { const age = ((r.end || Date.now()) - new Date(+m[3], +m[1] - 1, +m[2]).getTime()) / 86400000; if (age > 300) { find("info", "The graphics driver is " + Math.round(age / 30) + " months old", gpu0.name + " · driver " + gpu0.driver + " from " + gpu0.driverDate + "."); if (kind !== "normal") tip("Update the graphics driver."); } } }
    if (sxs) find("bad", "A runtime the game needs is missing or broken", (sxs.message || "").split("\n")[0].slice(0, 300));
    if (dotnet) find("bad", "The .NET runtime reported the error", (dotnet.message || "").slice(0, 600));
    if (tag("files").length && kind !== "normal") { find("warn", "The log mentions damaged or missing files", "“" + tag("files").slice(-1)[0].text.slice(0, 200) + "”"); tip("Verify the game's files in its launcher."); }
    if (tag("driver").length) find("warn", "The log mentions the driver or hardware support", "“" + tag("driver").slice(-1)[0].text.slice(0, 200) + "”");
    const ov = (r.others || []).filter(Boolean);
    if (ov.length && (kind === "crash" || kind === "gpu" || kind === "hang")) find("info", "Running at the same time", ov.join(", ") + ". Overlays and tuning tools hook into games; closing them is a quick test.");
    if ((kind === "crash" || kind === "hang" || kind === "error") && !dumps.length && r.platform !== "android" && !linux && !(r.localDumps && r.localDumps.on)) find("info", "No crash dump was saved", "Windows can keep a small crash dump for this game, which shows exactly where it crashed. Turn it on for this game on the Games tab.");
    if (r.exit && r.exit.hungTotalMs > 20000 && kind !== "hang") find("info", "It stopped responding at times", "Its window didn't answer for about " + fmtDur(r.exit.hungTotalMs) + " in total during the session (long loads or stutters).");

    const facts = [];
    facts.push(["Played for", dur > 0 ? fmtDur(dur) : "unknown"]);
    if (linux && r.exit && r.exit.signal) facts.push(["Ended with", r.exit.signal + ({ SIGSEGV: " (segmentation fault: a memory access it wasn't allowed)", SIGABRT: " (the game stopped itself)", SIGILL: " (illegal instruction)", SIGFPE: " (arithmetic error)", SIGBUS: " (bad memory access)", SIGKILL: " (ended by force)", SIGTERM: " (asked to close)", SIGTRAP: " (a safety check stopped it)" }[r.exit.signal] || "")]);
    else if (r.exit && r.exit.how !== "lost" && !noCode) facts.push(["Exit code", code > 255 || code === 0 ? hex(code) + (info ? " · " + info[0] : code === 0 ? " · normal" : "") : String(code)]);
    if (r.game && r.game.proton) facts.push(["Proton", r.game.proton]);
    if (modName) facts.push(["Crashed inside", modName + (mod ? " · " + mod.what : "")]);
    if (errCode && errCode !== code) facts.push(["Error", hex(errCode) + (errInfo ? " · " + errInfo[0] : "")]);
    if (st.peakPm) facts.push(["Game memory", "peak " + fmtMB(st.peakPm) + (st.lastPm ? " · at the end " + fmtMB(st.lastPm) : "")]);
    if (st.peakVram) facts.push(["Game video memory", "peak " + fmtMB(st.peakVram) + (gpu0 && gpu0.vramMB ? " of " + fmtMB(gpu0.vramMB) : "")]);
    if (st.maxGpuTemp > 0) facts.push(["Graphics card", "peak " + Math.round(st.maxGpuTemp) + " °C" + (st.maxGpuPower > 0 ? " · " + Math.round(st.maxGpuPower) + " W" : "")]);
    if (st.lastRamFree >= 0) facts.push(["PC memory at the end", fmtMB(st.lastRamFree) + " free" + (st.lastCommit >= 0 ? " · " + Math.round(st.lastCommit) + "% committed" : "")]);
    if (linux && r.exit && (r.exit.signal === "SIGKILL" || r.exit.signal === "SIGTERM") && kind === "error") {
      title = r.exit.signal === "SIGKILL" ? "The game was ended by force" : "The game was asked to close";
      why = r.exit.signal === "SIGKILL" ? "It was ended with SIGKILL: by you, by Steam's Stop button, or by the system when memory ran out (the system log says so if it was memory)." : "It was asked to close (SIGTERM): usually Steam's Stop button, or the PC shutting down.";
    }
    // GTA San Andreas: songs in User Tracks whose names it can't read (see gtaTracks in watch.js)
    const gt = r.gtaTracks;
    if (gt && gt.badCount > 0 && kind !== "normal") {
      const shown = gt.bad.slice(0, 15).map((n) => "• " + n).join("\n") + (gt.badCount > 15 ? "\n…and " + (gt.badCount - 15) + " more" : "");
      find("warn", "GTA San Andreas: " + gt.badCount + (gt.badCount === 1 ? " song it can't read" : " songs it can't read"),
        "These names in " + gt.where + " have characters GTA San Andreas can't read on this PC (it reads file names with Windows' older \"language for non-Unicode programs\" setting), and scanning them can crash it:\n" + shown);
      T.unshift("Rename the songs in " + gt.where + " whose names GTA San Andreas can't read (listed under \"Also noticed\"), using plain letters and numbers. Or switch Windows' language for non-Unicode programs to match them (Settings > Time & language > Language & region > Administrative language settings > Change system locale), then restart the PC.");
    }
    if (linux && r.exit && r.exit.via) facts.push(["How it was watched", "Started through the Steam launch option"]);
    if (linux) {
      const wine = !!(r.game && r.game.wine), tips = T.filter((t) => !WINDOWS_ONLY_TIP.test(t)).map(linuxWords);
      if (kind !== "normal" && kind !== "unknown" && kind !== "pc") {
        if (wine) tips.push("This game runs through Proton / Wine: try another Proton version (in Steam: Properties > Compatibility), and look the game up on ProtonDB for the settings other players needed.");
        if (kind === "gpu" || kind === "crash" || kind === "vram") tips.push("Update the graphics driver through your distribution (Mesa for AMD and Intel cards, the NVIDIA driver package for NVIDIA).");
      }
      return { kind, title: linuxWords(title), why: linuxWords(why), findings: F.map((f) => ({ sev: f.sev, title: linuxWords(f.title), text: linuxWords(f.text) })), tips, facts: facts.map(([k, v]) => [linuxWords(k), linuxWords(v)]), module: modName, errCode, errName: errInfo ? errInfo[0] : "" };
    }
    return { kind, title, why, findings: F, tips: T, facts, module: modName, errCode, errName: errInfo ? errInfo[0] : "" };
  }

  /** The report as plain text, to paste to a developer, a forum or support. */
  function summaryText(r, a) {
    a = a || analyze(r); const g = r.game || {}, sys = r.system || {}, L = [];
    L.push("aGoldenDiagnose report: " + (g.name || g.exe || "game") + (g.version ? " " + g.version : ""));
    L.push(new Date(r.end || r.start).toLocaleString() + " · " + a.title); L.push(a.why); L.push("");
    for (const [k, v] of a.facts) L.push(k + ": " + v);
    if (a.findings.length) { L.push(""); for (const f of a.findings) L.push("- " + f.title + ": " + f.text); }
    L.push(""); L.push("PC: " + [sys.cpu, sys.ramMB ? fmtMB(sys.ramMB) + " RAM" : "", ...(sys.gpus || []).map((x) => x.name + (x.vramMB ? " " + fmtMB(x.vramMB) : "") + " (driver " + x.driver + ")"), (sys.os || "") + " " + (sys.osVersion || "") + (sys.osBuild ? " build " + sys.osBuild : "")].filter(Boolean).join(" · "));
    const hits = (r.logHits || []).slice(-8); if (hits.length) { L.push(""); L.push("Log lines:"); for (const h of hits) L.push("  [" + h.file + ":" + h.n + "] " + h.text.slice(0, 240)); }
    const evs = (r.events || []).filter((e) => e.level <= 2).slice(0, 5); if (evs.length) { L.push(""); L.push(r.platform === "linux" ? "System log:" : "Windows events:"); for (const e of evs) L.push("  " + e.provider + " " + e.id + ": " + String(e.message || (e.data || []).join(" | ")).replace(/\s+/g, " ").slice(0, 260)); }
    return L.join("\n");
  }

  /** A short version for a Discord message (under its 2000-character limit), with the error lines in a code block. */
  function discordText(r, a) {
    a = a || analyze(r); const g = r.game || {}, sys = r.system || {}, L = [];
    const gpu = (sys.gpus || []).filter((x) => x && x.name && !/basic|remote|virtual|indirect/i.test(x.name)).sort((x, y) => (y.vramMB || 0) - (x.vramMB || 0))[0];
    L.push("**" + (g.name || g.exe || "Game") + (g.version ? " " + g.version : "") + "**: " + a.title);
    L.push(a.why.slice(0, 400));
    const f = a.facts.filter(([k]) => k !== "Played for").slice(0, 5).map(([k, v]) => k + ": " + v); if (f.length) L.push("> " + f.join("\n> "));
    L.push("PC: " + [sys.cpu, sys.ramMB ? fmtMB(sys.ramMB) + " RAM" : "", gpu ? gpu.name + (gpu.driver ? " (driver " + gpu.driver + ")" : "") : "", [sys.os, sys.osVersion, sys.osBuild].filter(Boolean).join(" ")].filter(Boolean).join(" · "));
    const hits = (r.logHits || []).slice(-6).map((h) => h.text.slice(0, 160).replace(/`/g, "'"));
    let out = L.join("\n");
    if (hits.length) { let block = "\n```\n"; for (const h of hits) { if ((out + block + h + "\n```").length > 1900) break; block += h + "\n"; } out += block + "```"; }
    return (out + "\n-# from aGoldenDiagnose").slice(0, 1990);
  }

  /** Crash patterns: what the reports say together that one report can't. `reports` are the summaries (head.json). */
  const KIND_WORDS = { crash: ["crash", "crashes"], gpu: ["graphics-driver failure", "graphics-driver failures"], vram: ["out-of-video-memory crash", "out-of-video-memory crashes"], oom: ["out-of-memory crash", "out-of-memory crashes"], hang: ["freeze", "freezes"], start: ["failed start", "failed starts"], error: ["error exit", "error exits"], pc: ["PC restart", "PC restarts"], lost: ["lost session", "lost sessions"] };
  const PC_KINDS = { gpu: "the graphics card or its driver", vram: "video memory", oom: "the PC's memory", pc: "the PC itself (restarts, blue screens)" };
  const r0os = (list) => list.some((r) => r.platform === "linux" || /^kernel/.test(r.osb || "")) ? "the system (kernel)" : "Windows";
  function patterns(reports, now) {
    now = now || Date.now();
    const DAY = 86400000, recent = (reports || []).filter((r) => r && KIND_WORDS[r.kind] && now - (r.end || 0) < 30 * DAY).sort((a, b) => a.end - b.end), out = [];
    const n = (c, k) => c + " " + KIND_WORDS[k][c === 1 ? 0 : 1], when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    // several different games failing within minutes of each other: the cause is usually the PC
    const used = new Set();
    for (let i = 0; i < recent.length; i++) {
      if (used.has(i)) continue;
      const group = [i]; for (let j = i + 1; j < recent.length && recent[j].end - recent[i].end <= 15 * 60000; j++) group.push(j);
      const games = [...new Set(group.map((x) => recent[x].game))];
      if (games.length >= 2) { group.forEach((x) => used.add(x)); out.push({ key: "burst:" + recent[i].end, sev: "bad", title: games.length + " different games had problems within 15 minutes (" + when(recent[i].end) + ")", text: games.join(", ") + ". When several games fail at the same moment, the cause is almost never the games: look at the PC (graphics driver, temperatures, memory, power). The PC tab's log around that time may show it.", game: "" }); }
    }
    // one cause showing up in several games
    const byKind = {}; for (const r of recent) if (PC_KINDS[r.kind]) (byKind[r.kind] = byKind[r.kind] || new Set()).add(r.game);
    for (const k of Object.keys(byKind)) if (byKind[k].size >= 2) out.push({ key: "kind:" + k, sev: "warn", title: "Problems with " + PC_KINDS[k] + " in " + byKind[k].size + " different games", text: [...byKind[k]].join(", ") + ". The same failure in different games points to the PC, not to one game: start with the graphics driver, temperatures and any overclock.", game: "" });
    const byMod = {}; for (const r of recent) if (r.module) (byMod[r.module.toLowerCase()] = byMod[r.module.toLowerCase()] || { name: r.module, games: new Set() }).games.add(r.game);
    for (const m of Object.values(byMod)) if (m.games.size >= 2) out.push({ key: "mod:" + m.name.toLowerCase(), sev: "warn", title: m.name + " is in the crashes of " + m.games.size + " different games", text: [...m.games].join(", ") + ". A file shared by several games is usually a driver, an overlay or a system library: updating or turning off what it belongs to is the first thing to try.", game: "" });
    // the problems started after the graphics driver or the system changed (each report remembers both)
    for (const [field, what] of [["drv", "the graphics driver"], ["osb", r0os(recent)]]) {
      const seq = recent.filter((r) => r[field]); if (seq.length < 3) continue;
      for (let i = 1; i < seq.length; i++) {
        if (seq[i][field] === seq[i - 1][field]) continue;
        const after = seq.slice(i).filter((r) => r[field] === seq[i][field]), before = seq.slice(0, i);
        const since = seq[i].end, gapBefore = since - seq[i - 1].end;
        if (after.length >= 3 && after.length >= 2 * before.length && gapBefore > 2 * DAY) {
          const games = [...new Set(after.map((r) => r.game))];
          out.push({ key: "chg:" + field + ":" + seq[i - 1][field] + ">" + seq[i][field], sev: "warn", title: after.length + " problems since " + what + " changed (" + seq[i - 1][field] + " → " + seq[i][field] + ")",
            text: "Before that there " + (before.length === 1 ? "was 1" : "were " + before.length) + " in the last 30 days. Since " + when(since) + ": " + games.slice(0, 5).join(", ") + ". If they started then, " +
              (field === "drv" ? "going back to the driver before (a clean install of version " + seq[i - 1][field] + ") is worth a try." : "a system update may be the cause: look for a newer driver for your graphics card, or a fix from the game's makers.") });
        }
      }
    }
    // one game failing again and again
    const byGame = {}; for (const r of recent) (byGame[r.key || r.game] = byGame[r.key || r.game] || []).push(r);
    for (const list of Object.values(byGame)) {
      if (list.length < 3) continue;
      const kinds = {}; for (const r of list) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]), mods = {}; for (const r of list) if (r.module) mods[r.module] = (mods[r.module] || 0) + 1;
      const mod = Object.entries(mods).sort((a, b) => b[1] - a[1])[0], week = list.filter((r) => now - r.end < 7 * DAY).length;
      let text = top.map(([k, c]) => n(c, k)).join(", ") + ".";
      if (top[0][1] >= Math.ceil(list.length * 0.6) && top[0][1] >= 2) text += " Mostly the same thing each time, so one fix is likely to cover them.";
      if (mod && mod[1] >= 2) text += " " + mod[1] + " of them happened in " + mod[0] + ".";
      if (week >= 3) text += " " + week + " of them this week.";
      out.push({ key: "game:" + (list[0].key || list[0].game), sev: week >= 3 ? "bad" : "warn", title: list[0].game + ": " + list.length + " problems in the last 30 days", text, game: list[0].key || "" });
    }
    return out;
  }

  const api = { discordText, linuxWords, patterns, analyze, summaryText, scanLog, moduleKind, codeInfo, crashCode, hex, fmtMB, fmtDur, LOG_PATTERNS, TAG_NAME };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Diagnose = api;
})(typeof window !== "undefined" ? window : globalThis);
