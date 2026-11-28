/* aGoldenDiagnose: watching games and building crash reports.
 *
 * The helper (native\agd-helper.exe) tells this file when a game starts, sends a sample of what it is using every
 * couple of seconds, and says when it ends and with which exit code. When a game ends badly this file asks the helper
 * for what Windows wrote down about it (event log), finds the log and dump files written during the session, copies
 * them next to the report, reads them for the lines that matter and saves everything as one report:
 *
 *   Documents\aGoldenDiagnose\<Game>\<date time>\report.json   the report      timeline.jsonl   the samples
 *                                               \files\...     the logs and dumps that were collected
 *                                               \summary.txt   the report as plain text
 */
const { app, ipcMain, shell, Notification, safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const A = require(path.join(__dirname, "web", "analyze.js"));
const AUTOSTART = require("./autostart");
const LINUX = process.platform === "linux";
const RUN = LINUX ? require("./linux-runs") : null;          // Linux: games started through the Steam launch option
// The copy given to other people asks, when exporting a report, whether to hide the user name and PC name in the .zip (the build flips this).
const SHARED = true;
const PC = require("./pc");          // the PC tab: the PC itself and the internet, incidents, keep alive

const DATA = path.join(app.getPath("documents"), "aGoldenDiagnose");
const CFG_FILE = path.join(app.getPath("userData"), "diagnose.json");
const DUMP_DIR = path.join(DATA, "_dumps");

/* Older games read file and folder names with Windows' older "language for non-Unicode programs" setting (the ANSI
 * code page). A name with characters outside it can't be opened by them, and a game scanning a folder that holds one
 * (its mods, music, saves…) can fail or crash. Any game: if its program uses the older way of listing folders, the
 * game's own folder and the Documents folders it wrote to while it ran are checked. Only names are read: nothing is
 * renamed, moved or sent. */
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function ansiCodePage() {
  try { const o = require("child_process").execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { encoding: "utf8", windowsHide: true, timeout: 5000 }); const m = /ACP\s+REG_SZ\s+(\d+)/.exec(o); return m ? +m[1] : 0; } catch { return 0; }
}
// does the game's program list folders the older way (FindFirstFileA / FindFirstFileExA in what it uses)?
function usesAnsiFolders(exe) {
  try {
    const st = fs.statSync(exe); if (st.size > 200e6) return false;
    const b = fs.readFileSync(exe);
    return b.includes(Buffer.from("FindFirstFileA\0", "latin1")) || b.includes(Buffer.from("FindFirstFileExA\0", "latin1"));
  } catch { return false; }
}
function ansiNames(s, start) {
  if (!usesAnsiFolders(s.path)) return { checked: false, why: "unicode" };
  const acp = ansiCodePage();
  // only a Western (1252) setting can be checked exactly here; with any other setting nothing is listed
  if (acp !== 1252) return { checked: false, why: "acp", acp };
  const readable = (name) => [...name].every((c) => c.charCodeAt(0) < 256 || CP1252_EXTRA.includes(c));
  let docs = ""; try { docs = require("electron").app.getPath("documents"); } catch {}
  if (!docs) docs = path.join(os.homedir(), "Documents");
  const roots = [];
  if (s.dir) roots.push({ dir: s.dir, label: "the game's folder" });
  // the Documents folders the game wrote to while it ran (its saves, mods, music…), also inside "My Games"
  for (const base of [docs, path.join(docs, "My Games")]) {
    let list = []; try { list = fs.readdirSync(base, { withFileTypes: true }); } catch {}
    for (const e of list) {
      if (!e.isDirectory() || e.name === "My Games") continue;
      const d = path.join(base, e.name);
      try { if (fs.statSync(d).mtimeMs >= start - 60000 || recentInside(d, start)) roots.push({ dir: d, label: "Documents\\" + path.relative(docs, d) }); } catch {}
    }
  }
  const bad = []; let seen = 0;
  for (const r of roots) {
    (function walk(d, depth, rel) {
      let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (++seen > 40000) return;
        const shown = r.label + "\\" + (rel ? rel + "\\" : "") + e.name;
        if (!readable(e.name)) bad.push(shown + (e.isDirectory() ? "\\" : ""));
        if (e.isDirectory() && depth < 4) walk(path.join(d, e.name), depth + 1, rel ? rel + "\\" + e.name : e.name);
      }
    })(r.dir, 0, "");
  }
  return { checked: true, acp, folders: roots.map((r) => r.label), badCount: bad.length, bad: bad.slice(0, 40) };
}
// a folder whose own date didn't change can still hold files the game just wrote (one level down)
function recentInside(d, start) {
  try { for (const e of fs.readdirSync(d, { withFileTypes: true }).slice(0, 300)) { const p = path.join(d, e.name); if (fs.statSync(p).mtimeMs >= start - 60000) return true; } } catch {}
  return false;
}
let CFG = { games: {}, ignore: [], auto: false, keepNormal: false, keep: 25, interval: 2000, notify: false, startup: false };
try { CFG = Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, "utf8"))); } catch {}
const saveCfg = (quiet) => { try { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 1)); } catch {} if (quiet !== true) syncSoon(); };
let getWin = () => null, log = () => {};
const tell = (ch, ...a) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, ...a); };
const safe = (s) => String(s || "game").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "").trim().slice(0, 60) || "game";
const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes()) + "." + p(d.getSeconds()); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- the helper */
let helper = null, helperOk = false, nextId = 1, buf = "";
const pending = new Map();
// Linux: the helper is a script (linux-helper.js) run by Electron's own Node, kept outside the packed app so it can be read and started
const linuxHelper = () => { const un = path.join(process.resourcesPath || "", "app.asar.unpacked", "linux-helper.js"); return fs.existsSync(un) ? un : path.join(__dirname, "linux-helper.js"); };
const helperPath = () => { if (LINUX) return linuxHelper(); const packed = path.join(process.resourcesPath || "", "native", "agd-helper.exe"); return fs.existsSync(packed) ? packed : path.join(__dirname, "native", "agd-helper.exe"); };
function startHelper() {
  if (process.platform !== "win32" && !LINUX) return;
  try { helper = LINUX ? spawn(process.execPath, [helperPath()], { stdio: ["pipe", "pipe", "ignore"], env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }) }) : spawn(helperPath(), [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { log("helper didn't start: " + e.message); alog("the watcher didn't start: " + e.message); helper = null; return; }
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { let o = null; try { o = JSON.parse(line); } catch {} if (o) onHelper(o); } } });
  helper.on("error", (e) => { log("helper error: " + e.message); });
  helper.on("exit", (code) => {
    helperOk = false; helper = null; for (const [, p] of pending) p({ ok: false, error: "the watcher stopped" }); pending.clear();
    for (const s of [...live.values()]) lose(s);
    if (!quitting) { log("helper ended (" + code + "), starting it again"); alog("the watcher ended (code " + code + "), starting it again"); setTimeout(startHelper, 3000); }
    tell("diag-update");
  });
  ask("hello").then((r) => { helperOk = !!(r && r.ok); pushWatch(); tell("diag-update"); if (helperOk) { try { PC.helperReady(helperPath()); } catch (e) { log("keep alive: " + e.message); } } });
}
function ask(cmd, args, timeout) {
  return new Promise((res) => {
    if (!helper || !helper.stdin.writable) return res({ ok: false, error: "the watcher isn't running" });
    const id = nextId++, t = setTimeout(() => { pending.delete(id); res({ ok: false, error: "no answer" }); }, timeout || 30000);
    pending.set(id, (r) => { clearTimeout(t); res(r); });
    try { helper.stdin.write(JSON.stringify(Object.assign({ id, cmd }, args || {})) + "\n"); } catch (e) { clearTimeout(t); pending.delete(id); res({ ok: false, error: e.message }); }
  });
}
function pushWatch() {
  const names = Object.values(CFG.games).filter((g) => g.watch !== false).map((g) => g.exe);
  ask("watch", { names, ignore: CFG.ignore.concat(Object.values(CFG.games).filter((g) => g.watch === false).map((g) => g.exe)), auto: CFG.auto ? 1 : 0, interval: CFG.interval });
}
let lastHelperErr = "";          // the same error every few seconds is written to the log once
function onHelper(o) {
  if (o.re !== undefined) { const p = pending.get(o.re); if (p) { pending.delete(o.re); p(o); } return; }
  if (o.ev === "found") onFound(o); else if (o.ev === "s") onSample(o); else if (o.ev === "exit") onExit(o); else if (o.ev === "error") { log("helper: " + o.message); const m = String(o.message || ""); if (m !== lastHelperErr) { lastHelperErr = m; alog("the watcher reported: " + m.slice(0, 1500)); } }
}

/* ---------------------------------------------------------------- sessions (a game being watched right now) */
const live = new Map();          // pid -> session
const keyOf = (exe) => String(exe || "").toLowerCase();
/* What was seen and decided (a game found, how it ended, how it was read) goes to the app's log through the window's own
 * logger, so a missed crash can be looked into afterwards. Only these lines, never file contents. */
const alog = (line) => tell("diag-log", String(line));

/* ---------------------------------------------------------------- sync (your own server)
 * The games list and the hidden list are kept on the server under "agd:" keys, so they
 * are the same on every PC. Each sync compares three things: what this PC had at the last sync, what it has now, and
 * what the server has. What was added or removed here since then is kept and sent up; the rest follows the server.
 * Reports never leave the PC. */
const SYNC_DEFAULT = "";
const SYNC_FILE = path.join(app.getPath("userData"), "sync.json");
let SY = { server: SYNC_DEFAULT, user: "", token: "", device: "", cursor: 0, at: 0, error: "", base: null };
function loadSync() {
  try { SY = Object.assign(SY, JSON.parse(fs.readFileSync(SYNC_FILE, "utf8"))); } catch {}
  if (SY.token && safeStorage.isEncryptionAvailable()) { try { SY.token = safeStorage.decryptString(Buffer.from(SY.token, "base64")); } catch { SY.token = ""; } }
  if (!SY.device) { SY.device = "agd-" + crypto.randomBytes(6).toString("hex"); saveSync(); }
}
function saveSync() {
  const out = Object.assign({}, SY);
  if (out.token && safeStorage.isEncryptionAvailable()) out.token = safeStorage.encryptString(out.token).toString("base64");
  try { fs.mkdirSync(path.dirname(SYNC_FILE), { recursive: true }); fs.writeFileSync(SYNC_FILE, JSON.stringify(out)); } catch {}
}
async function sapi(method, p, body) {
  let r;
  try { r = await fetch(SY.server.replace(/\/+$/, "") + p, { method, headers: Object.assign({ "Content-Type": "application/json" }, SY.token ? { Authorization: "Bearer " + SY.token } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Couldn't reach your server."); }
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && p !== "/login") { SY.token = ""; saveSync(); }
  if (!r.ok) throw new Error(j.error || "Your server answered " + r.status + ".");
  return j;
}
const slim = (g) => ({ exe: g.exe, name: g.name, watch: g.watch !== false, how: g.how || "you", named: !!g.named });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The three-way merge. Returns the lists both sides should end up with. */
function mergeLists(base, cur, remote, known) {      // known: the server already has "base" (false the first time on this PC)
  const rH = Array.isArray(remote.hidden) ? remote.hidden.filter((k) => typeof k === "string") : base.hidden, rG = remote.games && typeof remote.games === "object" ? remote.games : base.games;
  const added = cur.hidden.filter((k) => !base.hidden.includes(k)), removed = base.hidden.filter((k) => !cur.hidden.includes(k));
  const hidden = [...new Set(rH.filter((k) => !removed.includes(k)).concat(added))].sort();
  const games = Object.assign({}, rG);
  for (const k of new Set(Object.keys(cur.games).concat(Object.keys(base.games)))) if (!same(cur.games[k], base.games[k])) { if (cur.games[k]) games[k] = cur.games[k]; else delete games[k]; }
  // a program is either hidden or a game: what was done on this PC since the last sync decides, otherwise hidden wins
  for (const k of hidden.slice()) if (games[k]) { if (!added.includes(k) && cur.games[k] && !same(cur.games[k], base.games[k])) hidden.splice(hidden.indexOf(k), 1); else delete games[k]; }
  return { hidden, games, sendHidden: !same(hidden, Array.isArray(remote.hidden) ? remote.hidden : known ? base.hidden : null), sendGames: !same(games, remote.games || (known ? base.games : null)) };
}
let syncTimer = null, syncing = false, syncAgain = false;
function syncSoon() { if (!SY.token) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), 2000); }
async function syncNow() {
  if (!SY.token) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const first = !SY.at || !SY.base;
    const got = await sapi("GET", "/sync?since=" + (first ? 0 : SY.cursor));
    const remote = {};
    for (const c of got.changes || []) if (first || c.dev !== SY.device) { if (c.k === "agd:hidden") remote.hidden = c.v; else if (c.k === "agd:games") remote.games = c.v; }
    SY.cursor = got.cursor || SY.cursor;
    const base = SY.base || { hidden: [], games: {} }, cur = { hidden: CFG.ignore.slice(), games: {} };
    for (const [k, g] of Object.entries(CFG.games)) cur.games[k] = slim(g);
    const m = mergeLists(base, cur, remote, !first);
    // this PC follows the merged lists
    for (const k of Object.keys(CFG.games)) if (!m.games[k]) { for (const s of [...live.values()]) if (s.key === k) { ask("detach", { pid: s.pid }); lose(s); } delete CFG.games[k]; }
    for (const [k, g] of Object.entries(m.games)) CFG.games[k] = Object.assign({ added: Date.now() }, CFG.games[k] || {}, g);
    CFG.ignore = m.hidden.slice();
    const send = []; if (m.sendHidden) send.push({ k: "agd:hidden", v: m.hidden }); if (m.sendGames) send.push({ k: "agd:games", v: m.games });
    if (send.length) { const r = await sapi("POST", "/sync", { device: SY.device, changes: send }); SY.cursor = r.cursor || SY.cursor; }
    SY.base = { hidden: m.hidden, games: m.games }; SY.at = Date.now(); SY.error = "";
    if (!same(cur, { hidden: m.hidden, games: m.games })) { saveCfg(true); pushWatch(); tell("diag-update"); }
  } catch (e) { SY.error = e.message; }
  finally { syncing = false; saveSync(); if (syncAgain) { syncAgain = false; setTimeout(() => syncNow(), 500); } }
}
function gameRoot(exePath) {     // the game's own folder: up from Binaries\Win64 and the like
  let dir = path.dirname(exePath); const m = /^(.*[\\/]steamapps[\\/]common[\\/][^\\/]+)/i.exec(exePath); if (m) return m[1];
  for (let i = 0; i < 4; i++) { const b = path.basename(dir).toLowerCase(); if (/^(binaries|win64|win32|winGDK|wingdk|linux|bin|bin64|bin32|x64|x86|x86_64|shipping|retail|release|game|engine|system|launcher|client)$/.test(b)) dir = path.dirname(dir); else break; }
  return dir;
}
function prettyName(exe) { return exe.replace(/\.(exe|x86_64|x86|sh|appimage)$/i, "").replace(/[-_.](win64|win32|wingdk|x64|x86|shipping|dx11|dx12|vulkan|retail|final|release|64|32|game|client)\b/gi, "").replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || exe; }
let hostedServer = () => null;
async function onFound(o) {
  const hs = hostedServer(o);
  const key = hs ? hs.key : keyOf(o.name);
  alog(`found ${o.name} (pid ${o.pid}, ${o.why}) at ${o.path}${CFG.ignore.includes(key) ? " (hidden, left alone)" : ""}`);
  if (!o.name || CFG.ignore.includes(key) || (CFG.games[key] && CFG.games[key].watch === false)) { ask("detach", { pid: o.pid }); return; }
  if (live.has(o.pid)) return;
  let g = CFG.games[key];
  if (!g) { g = CFG.games[key] = { exe: o.name, name: hs ? hs.name : prettyName(o.name), path: o.path, watch: true, added: Date.now(), how: o.why === "library" ? "auto" : "you" }; }
  g.path = o.path || g.path; g.lastSeen = Date.now(); saveCfg();
  const s = { pid: o.pid, key, exe: o.name, path: o.path, dir: hs ? hs.dir : o.path ? gameRoot(o.path) : "", start: o.startMs || Date.now(), title: o.title || "", n: 0, last: null, first: null, stats: { peakWs: 0, peakPm: 0, peakVram: 0, maxGpuTemp: -1, maxGpuPower: -1, minRamFree: -1, maxCommit: -1, cpuSum: 0, gpuSum: 0 }, others: [], modules: null, ver: null, prefix: o.prefix || "", wine: !!o.wine, anc: o.anc || [] };
  // the same game still running from before this app was restarted: carry on in the same report folder
  const again = findOpen().find((x) => x.pid === o.pid && Math.abs(x.start - s.start) < 3000);
  s.folder = again ? again.folder : path.join(DATA, safe(g.name), stamp(s.start));
  try { fs.mkdirSync(s.folder, { recursive: true }); fs.writeFileSync(path.join(s.folder, "live.json"), JSON.stringify({ open: true, pid: s.pid, exe: s.exe, path: s.path, dir: s.dir, start: s.start, key, prefix: s.prefix, wine: s.wine })); } catch (e) { log("couldn't make the report folder: " + e.message); }
  try { s.tl = fs.createWriteStream(path.join(s.folder, "timeline.jsonl"), { flags: "a" }); } catch {}
  live.set(o.pid, s);
  log("watching " + o.name + " (pid " + o.pid + ", " + o.why + ")");
  tell("diag-update");
  if (o.path) ask("verinfo", { path: o.path }).then((v) => { if (v && v.ok) { s.ver = v; const nice = (v.product || v.description || "").trim(); if (nice && nice.length >= 3 && nice.length <= 60 && !/^(unreal|unity|bootstrap|launcher)/i.test(nice) && g.how !== "renamed" && !g.named) { g.name = nice; g.named = true; saveCfg(); tell("diag-update"); } } });
  setTimeout(() => { if (live.get(o.pid) === s) around(s); }, 25000);
  setTimeout(() => { if (live.get(o.pid) === s) ask("modules", { pid: o.pid }).then((m) => { if (m && m.ok) s.modules = m.list; }); }, 60000);
}
/* Programs known to hook into games or to matter when one crashes. */
const NOTABLE = [[/^discord/i, "Discord"], [/^(rtss|rtsshooksloader|encoderserver)/i, "RivaTuner (RTSS)"], [/^msiafterburner/i, "MSI Afterburner"], [/^gameoverlayui/i, "Steam overlay"], [/^(nvidia overlay|nvidia share|nvsphelper)/i, "NVIDIA overlay"], [/^obs(64|32)?\.exe/i, "OBS"], [/^medal/i, "Medal"], [/^overwolf/i, "Overwolf"], [/^(reshade|specialk)/i, "ReShade / Special K"], [/^losslessscaling/i, "Lossless Scaling"], [/^wallpaper(32|64)/i, "Wallpaper Engine"], [/^(icue|corsair)/i, "Corsair iCUE"], [/^(razer|rzsdk|razercentral)/i, "Razer software"], [/^(lghub|lghub_agent)/i, "Logitech G HUB"], [/^(armoury|lightingservice|asus_framework)/i, "ASUS Armoury Crate"], [/^(msi\.center|dragoncenter|mysticlight)/i, "MSI Center"], [/^(steelseries)/i, "SteelSeries GG"], [/^(nahimic|sonicstudio)/i, "Nahimic / Sonic Studio"], [/^processlasso/i, "Process Lasso"], [/^(hwinfo|hwmonitor|aida64)/i, "hardware monitor"], [/^(vmware|virtualbox|vbox)/i, "a virtual machine"], [/^(cheatengine|wemod|vortex|modorganizer|flawless)/i, "a trainer / mod tool"], [/^(avp|avastui|avgui|mbam|ekrn|bdagent|mcshield|nortonsecurity)/i, "third-party antivirus"], [/^(xboxgamebar|gamebar)/i, "Xbox Game Bar"], [/^(playnite|ds4windows|rewasd|joytokey|x360ce|vjoy)/i, "controller / launcher tool"], [/^(sunshine|parsec|moonlight|steamstreaming|anydesk|teamviewer)/i, "streaming / remote desktop"], [/^mangohud/i, "MangoHud"], [/^obs$/i, "OBS"], [/^(goverlay|vkbasalt)/i, "vkBasalt / GOverlay"], [/^(corectrl|lact)$/i, "a graphics-card tuning tool"]];
async function around(s) {
  const r = await ask("allprocs"); if (!r || !r.ok) return;
  const got = new Set(); for (const n of r.list || []) for (const [re, label] of NOTABLE) if (re.test(n)) got.add(label);
  s.others = [...got];
}
function onSample(o) {
  const s = live.get(o.pid); if (!s) return;
  const st = s.stats; s.n++; s.last = o; if (!s.first && o.pm) s.first = o;
  if (o.title) s.title = o.title;
  st.peakWs = Math.max(st.peakWs, o.ws || 0); st.peakPm = Math.max(st.peakPm, o.pm || 0); st.peakVram = Math.max(st.peakVram, o.vram || 0);
  if (o.gt > 0) st.maxGpuTemp = Math.max(st.maxGpuTemp, o.gt); if (o.gp > 0) st.maxGpuPower = Math.max(st.maxGpuPower, o.gp);
  if (o.ramFree >= 0) st.minRamFree = st.minRamFree < 0 ? o.ramFree : Math.min(st.minRamFree, o.ramFree);
  if (o.commit >= 0) st.maxCommit = Math.max(st.maxCommit, o.commit);
  st.cpuSum += o.cpu || 0; st.gpuSum += o.gpu || 0;
  // timeline row: [t, cpu, ramMB, gpu, vramMB, pcCpu, pcMem%, pcVramMB, gpuTemp, notResponding(ms), commit%]
  try { if (s.tl) s.tl.write(JSON.stringify([o.t, o.cpu ?? -1, o.pm ?? -1, o.gpu ?? -1, o.vram ?? -1, o.sc ?? -1, o.sm ?? -1, o.sv ?? -1, o.gt ?? -1, o.hung || 0, o.commit ?? -1]) + "\n"); } catch {}
  if (s.n % 150 === 0) around(s);
  tell("diag-live", { pid: s.pid, key: s.key, cpu: o.cpu, pm: o.pm, gpu: o.gpu, vram: o.vram, gt: o.gt, hung: o.hung, t: o.t });
}
function statsOf(s) {
  const st = s.stats, l = s.last || {}, f = s.first || {}, hours = s.last && s.first ? (s.last.t - s.first.t) / 3600000 : 0;
  return { samples: s.n, peakWs: st.peakWs, peakPm: st.peakPm, peakVram: st.peakVram, maxGpuTemp: st.maxGpuTemp, maxGpuPower: st.maxGpuPower, minRamFree: st.minRamFree, maxCommit: st.maxCommit,
    avgCpu: s.n ? Math.round((st.cpuSum / s.n) * 10) / 10 : -1, avgGpu: s.n ? Math.round((st.gpuSum / s.n) * 10) / 10 : -1,
    lastPm: l.pm ?? 0, lastWs: l.ws ?? 0, lastVram: l.vram ?? 0, lastSysVram: l.sv ?? -1, lastRamFree: l.ramFree ?? -1, lastCommit: l.commit ?? -1, lastCpu: l.cpu ?? -1, lastGpu: l.gpu ?? -1, lastGpuTemp: l.gt ?? -1,
    firstPm: f.pm ?? 0, growMBh: hours > 0.25 && f.pm ? Math.round(((l.pm || 0) - f.pm) / hours) : 0 };
}
async function onExit(o) {
  const s = live.get(o.pid); if (!s) return;
  live.delete(o.pid); try { if (s.tl) s.tl.end(); } catch {}
  tell("diag-update");
  log(s.exe + " ended, code " + o.code + (o.hungMs ? ", not responding for " + o.hungMs + " ms" : ""));
  try { await finish(s, await exitOf(s, o), o.t || Date.now()); if (s.run) RUN.done(s.run); } catch (e) { log("report failed: " + (e && e.stack ? e.stack : e)); alog("report for " + s.exe + " failed: " + (e && e.stack ? e.stack : e)); tell("diag-closed", { name: s.exe, error: String((e && e.message) || e).slice(0, 200) }); }
}
async function exitOf(s, o) {
  const exit = { code: o.code >>> 0, hex: A.hex(o.code), hungMs: o.hungMs || 0, hungTotalMs: o.hungTotalMs || 0, how: "exit", unknown: !!o.unknownCode };
  if (!RUN) return exit;
  // started through the Steam launch option: the script knows how it really ended
  const r = await RUN.waitFor(s.anc); if (!r) return exit;
  s.run = r; alog(`${s.exe}: the launch option recorded exit code ${r.code}`);
  return Object.assign(exit, RUN.exit(r));
}
/** Linux: a game started through the launch option ended with an error while it wasn't being watched (the app was closed,
 *  or watching was off): the report is made from what the run left behind. */
async function reportRun(r) {
  const g0 = RUN.gameOf(r); if (!g0) { RUN.done(r); return; }
  const key = keyOf(g0.name); if (CFG.ignore.includes(key) || (CFG.games[key] && CFG.games[key].watch === false)) { RUN.done(r); return; }
  const g = CFG.games[key];
  const s = { pid: r.pid, key, exe: g0.name, path: g0.path, dir: gameRoot(g0.path), prefix: g0.prefix, wine: g0.wine, start: r.start, n: 0, last: null, first: null, stats: { peakWs: 0, peakPm: 0, peakVram: 0, maxGpuTemp: -1, maxGpuPower: -1, minRamFree: -1, maxCommit: -1, cpuSum: 0, gpuSum: 0 }, others: [], modules: null, ver: null, run: r };
  s.folder = path.join(DATA, safe(g ? g.name : prettyName(g0.name)), stamp(s.start));
  alog(`${s.exe}: a launch-option run ended with code ${r.code} while it wasn't watched; making its report`);
  try { await finish(s, Object.assign({ hungMs: 0, hungTotalMs: 0, how: "exit" }, RUN.exit(r)), r.end); } catch (e) { log("run report failed: " + e); } finally { RUN.done(r); }
}
/** The watcher (or this app) stopped while the game was running: nothing more will be known about how it ended. */
function lose(s) { live.delete(s.pid); try { if (s.tl) s.tl.end(); } catch {} }
function findOpen() {          // report folders left "open": the app or the PC went down while a game was being watched
  const out = [];
  try { for (const g of fs.readdirSync(DATA)) { if (g.startsWith("_")) continue; const gd = path.join(DATA, g); let subs = []; try { subs = fs.readdirSync(gd); } catch { continue; }
    for (const d of subs) { const f = path.join(gd, d); if (fs.existsSync(path.join(f, "live.json")) && !fs.existsSync(path.join(f, "report.json"))) { try { const j = JSON.parse(fs.readFileSync(path.join(f, "live.json"), "utf8")); j.folder = f; out.push(j); } catch {} } } } } catch {}
  return out;
}
async function closeLost() {
  for (const j of findOpen()) {
    if ([...live.values()].some((s) => s.folder === j.folder)) continue;
    const s = { pid: j.pid, key: j.key || keyOf(j.exe), exe: j.exe, path: j.path, dir: j.dir, prefix: j.prefix || "", wine: !!j.wine, start: j.start, folder: j.folder, n: 0, last: null, first: null, stats: { peakWs: 0, peakPm: 0, peakVram: 0, maxGpuTemp: -1, maxGpuPower: -1, minRamFree: -1, maxCommit: -1, cpuSum: 0, gpuSum: 0 }, others: [], modules: null, ver: null };
    let end = j.start;
    try { for (const line of fs.readFileSync(path.join(j.folder, "timeline.jsonl"), "utf8").split("\n")) { if (!line) continue; let a; try { a = JSON.parse(line); } catch { continue; } const o = { t: a[0], cpu: a[1], pm: a[2], gpu: a[3], vram: a[4], sc: a[5], sm: a[6], sv: a[7], gt: a[8], hung: a[9], commit: a[10], ramFree: -1 }; s.n++; s.last = o; if (!s.first) s.first = o; end = a[0]; s.stats.peakPm = Math.max(s.stats.peakPm, o.pm || 0); s.stats.peakVram = Math.max(s.stats.peakVram, o.vram || 0); if (o.gt > 0) s.stats.maxGpuTemp = Math.max(s.stats.maxGpuTemp, o.gt); s.stats.cpuSum += Math.max(0, o.cpu); s.stats.gpuSum += Math.max(0, o.gpu); } } catch {}
    try { await finish(s, { code: 0, hex: "", hungMs: 0, hungTotalMs: 0, how: "lost" }, end); } catch (e) { log("lost report failed: " + e); }
  }
}

/* ---------------------------------------------------------------- building the report */
const GENERIC = new Set(["game", "games", "launcher", "client", "win64", "win32", "shipping", "binaries", "bin", "x64", "x86", "the", "and", "studios", "studio", "entertainment", "interactive", "software", "corporation", "inc", "ltd", "llc", "gmbh", "limited", "company", "engine", "unreal", "unity", "application", "player", "steam", "data", "app", "apps", "program", "files", "retail", "release", "final", "edition", "windows", "microsoft"]);
/* Crash handlers: programs a game starts when it crashes, which write the dump and the crash log (and often show a
   "the game crashed" window). Unity's and Unreal's are known by name; any other one counts only when it runs from
   the game's own folder (browsers and chat apps have crash handlers of their own). */
const ENGINE_HANDLERS = /^(unitycrashhand|crashreportclie)/i;      // the start only: Linux cuts process names at 15 letters
const OTHER_HANDLERS = /crash.?(handler|report|sender|send|reporter|uploader)|^crashpad|^bugsplat|^bssndrpt|^sentry/i;
async function crashHandlers(s) {
  const r = await ask("procs", {}, 15000); if (!r || !r.ok) return [];
  const dir = String(s.dir || "").toLowerCase(), out = [];
  for (const p of r.list || []) {
    const n = String(p.name || ""), pth = String(p.path || "").toLowerCase();
    if (ENGINE_HANDLERS.test(n) || (OTHER_HANDLERS.test(n) && dir && pth.startsWith(dir))) out.push(n);
  }
  return [...new Set(out)];
}
function tokensFor(s, g) {
  const t = new Set(), add = (x) => { x = String(x || "").toLowerCase().trim(); if (x.length >= 4 && !GENERIC.has(x)) t.add(x); };
  const base = s.exe.replace(/\.(exe|x86_64|x86)$/i, ""); add(base); add(base.replace(/[-_.](win64|win32|wingdk|x64|x86|shipping|dx11|dx12|vulkan|retail|final|release)\b/gi, "").replace(/[-_.]+$/, ""));
  if (s.dir) add(path.basename(s.dir));
  for (const n of [g && g.name, s.ver && s.ver.product]) { if (!n) continue; add(n); add(String(n).replace(/[^a-z0-9]/gi, "")); const w = String(n).split(/[^a-z0-9]+/i).filter((x) => x.length >= 5 && !GENERIC.has(x.toLowerCase())); if (w.length === 1) add(w[0]); }
  if (s.ver && s.ver.company) { const c = String(s.ver.company).replace(/,?\s*(inc|ltd|llc|gmbh|corp|corporation|co|s\.?a\.?|limited)\.?$/i, "").trim(); add(c); add(c.replace(/[^a-z0-9]/gi, "")); }
  return [...t].slice(0, 10);
}
function readText(file, max) {          // a collected log as text (UTF-16 logs too)
  let b; try { b = fs.readFileSync(file); } catch { return ""; }
  if (b.length > max) b = b.subarray(b.length - max);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le");
  let zeros = 0; const n = Math.min(b.length, 2000); for (let i = 1; i < n; i += 2) if (b[i] === 0) zeros++;
  return zeros > n / 4 ? b.toString("utf16le") : b.toString("utf8");
}
const isText = (name) => !/\.(dmp|mdmp|hdmp)$/i.test(name);
let sysCache = null;
async function finish(s, exit, end) {
  const g = CFG.games[s.key] || { exe: s.exe, name: prettyName(s.exe) };
  const lost = exit.how === "lost";
  if (!lost) await sleep(6000);                   // Windows and the game's crash reporter need a moment to write their files
  // A crash handler still open after the game ended (Unity's, Unreal's, or one in the game's own folder) means the
  // game crashed, even when it ended with code 0; its report is read only once it's done writing (up to 90 s).
  const handlers = lost ? [] : await crashHandlers(s);
  if (handlers.length) {
    alog(`${s.exe}: crash handler running after it ended: ${handlers.join(", ")}; waiting for it to finish`);
    for (let i = 0; i < 45; i++) { await sleep(2000); if (!(await crashHandlers(s)).length) break; }
    await sleep(1500);
  }
  const evr = await ask("events", { from: s.start - 5000, to: Date.now() + 1000 }, 40000);
  const events = ((evr && evr.list) || []).sort((a, b) => a.t - b.t);
  const exeLow = s.exe.toLowerCase(), mine = (e) => (e.data || []).concat([e.message || ""]).some((d) => String(d).toLowerCase().includes(exeLow));
  const evidence = lost || exit.code !== 0 || exit.hungMs >= 5000 || events.some((e) => (/^Application (Error|Hang)$/.test(e.provider) && mine(e)) || ((e.provider === "Display" || /^nvlddmkm|^amdkmdag/i.test(e.provider)) && e.t >= end - 60000 && e.t <= end + 20000));
  alog(`${s.exe} ended: code ${exit.code}${exit.hex ? " (" + exit.hex + ")" : ""}, how ${exit.how || "exit"}, hung ${exit.hungMs || 0} ms, ${s.n} samples, ${events.length} Windows events, evidence from Windows: ${evidence}`);
  // No early "it simply closed" any more: a game whose own crash reporter catches the crash ends with code 0 and no
  // Windows error, and the only proof is in the files it wrote. Those are looked at first; see the check after the reading.
  if (lost && !events.some((e) => e.provider === "BugCheck" || (e.provider === "Microsoft-Windows-Kernel-Power" && e.id === 41) || e.provider === "Microsoft-Windows-WER-SystemErrorReporting") && s.n < 5) { try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {} return; }
  tell("diag-building", { key: s.key, name: g.name });
  // files written during the session
  const tokens = tokensFor(s, g), E = process.env, up = E.USERPROFILE || os.homedir(), docs = app.getPath("documents");
  const roots = [];
  if (s.dir) roots.push({ path: s.dir, depth: 6, needToken: false, kind: "game" });
  if (LINUX) {
    // a game run through Proton / Wine keeps its "Windows" folders inside its own prefix; a Linux game uses the usual places in your home folder
    if (s.prefix) { let users = []; try { users = fs.readdirSync(path.join(s.prefix, "drive_c", "users")).filter((u) => u !== "Public"); } catch {} for (const u of users) for (const sub of [["AppData", "Local"], ["AppData", "LocalLow"], ["AppData", "Roaming"], ["Documents"], ["Saved Games"]]) roots.push({ path: path.join(s.prefix, "drive_c", "users", u, ...sub), depth: 5, needToken: sub[0] === "Documents", kind: "game" }); }
    const home = os.homedir(), cfg = E.XDG_CONFIG_HOME || path.join(home, ".config"), data = E.XDG_DATA_HOME || path.join(home, ".local", "share");
    roots.push({ path: RUN.dir, depth: 0, needToken: false, kind: "game", match: "^steam-\\d+\\.log$" }); roots.push({ path: home, depth: 0, needToken: false, kind: "game", match: "^steam-\\d+\\.log$" });          // Proton's own log
    roots.push({ path: path.join(cfg, "unity3d"), depth: 3, needToken: true, kind: "game" }); roots.push({ path: cfg, depth: 3, needToken: true, kind: "game" }); roots.push({ path: data, depth: 3, needToken: true, kind: "game" }); roots.push({ path: docs, depth: 4, needToken: true, kind: "game" });
  } else
  for (const p of [E.LOCALAPPDATA, E.APPDATA, path.join(up, "AppData", "LocalLow"), docs, path.join(up, "Saved Games")]) if (p) roots.push({ path: p, depth: 5, needToken: true, kind: "game" });
  // crash reports some engines leave in the Temp folder (Unity: Temp\<company>\<game>\Crashes\Crash_<date>\)
  if (!LINUX && (E.TEMP || E.TMP)) roots.push({ path: E.TEMP || E.TMP, depth: 5, needToken: true, kind: "game" });
  roots.push({ path: DUMP_DIR, depth: 0, needToken: true, kind: "dump" });
  if (E.LOCALAPPDATA) { roots.push({ path: path.join(E.LOCALAPPDATA, "CrashDumps"), depth: 0, needToken: true, kind: "dump" }); roots.push({ path: path.join(E.LOCALAPPDATA, "Microsoft", "Windows", "WER"), depth: 2, needToken: true, kind: "wer" }); roots.push({ path: path.join(E.LOCALAPPDATA, "Temp"), depth: 2, needToken: true, kind: "game" }); }
  if (E.PROGRAMDATA) roots.push({ path: path.join(E.PROGRAMDATA, "Microsoft", "Windows", "WER"), depth: 2, needToken: true, kind: "wer" });
  const sc = await ask("scan", { roots, tokens, from: s.start - 2000, to: Date.now() + 1000 }, 60000);
  if (!evr || !evr.ok || !sc || !sc.ok) alog(`${s.exe}: reading Windows' event log ${evr && evr.ok ? "worked" : "failed (" + ((evr && evr.error) || "no answer") + ")"}, searching for files ${sc && sc.ok ? "worked" : "failed (" + ((sc && sc.error) || "no answer") + ")"}, watcher running: ${helperOk}`);
  let found = (sc && sc.result && sc.result.files) || [];
  found = found.filter((f) => !f.path.toLowerCase().startsWith(DATA.toLowerCase() + path.sep) || f.path.toLowerCase().startsWith(DUMP_DIR.toLowerCase()));
  { const seenPath = new Set(); found = found.filter((f) => { const k = f.path.toLowerCase(); if (seenPath.has(k)) return false; seenPath.add(k); return true; }); }      // one folder can be reached from two starting points
  found.sort((a, b) => (/dump/.test(b.kind) - /dump/.test(a.kind)) || b.mtime - a.mtime);
  found = found.slice(0, 60);
  const runLog = s.run && RUN ? RUN.files(s.run) : []; found = runLog.concat(found);          // what the game printed (launch option)
  const filesDir = path.join(s.folder, "files");
  const cp = found.length ? await ask("copy", { files: found, dest: filesDir, maxBytes: 400e6, tailBytes: 4e6 }, 120000) : { files: [] };
  for (const f of (cp && cp.files) || []) if (runLog.some((x) => x.path === f.orig) && f.name) { try { fs.renameSync(path.join(filesDir, f.name), path.join(filesDir, "game console.log")); f.name = "game console.log"; } catch {} }
  const files = ((cp && cp.files) || []).map((f) => ({ name: f.name, orig: f.orig, size: f.size, mtime: f.mtime || 0, kind: f.kind || "log", cut: !!f.cut, skipped: f.skipped || "" }));
  // crash dumps: what and where
  const dumps = [];
  for (const f of files) if (f.name && /\.(dmp|mdmp)$/i.test(f.name)) { const d = await ask("dump", { path: path.join(filesDir, f.name) }, 20000); if (d && d.ok) dumps.push(Object.assign({ name: f.name }, d, { modules: undefined, re: undefined })); }
  // the lines that matter in the text logs
  const logHits = [];
  for (const f of files) { if (!f.name || !isText(f.name) || logHits.length > 80) continue; const hits = A.scanLog(readText(path.join(filesDir, f.name), 5e6), 12, 5000); for (const h of hits) logHits.push(Object.assign({ file: f.name }, h)); f.hits = hits.length; }
  const sys = await ask("sysinfo", {}, 15000); if (sys && sys.ok) sysCache = sys.info;
  const ld = await ask("localdumps", { exe: s.exe, mode: "get" }, 8000);
  const report = { v: 1, platform: LINUX ? "linux" : "windows", id: path.relative(DATA, s.folder).replace(/\\/g, "/"), made: Date.now(),
    game: { name: g.name, exe: s.exe, path: s.path, dir: s.dir, version: s.ver ? s.ver.version : "", company: s.ver ? s.ver.company : "", product: s.ver ? s.ver.product : "", wine: !!s.wine },
    start: s.start, end, title: s.title || "", exit, stats: statsOf(s), events, files, dumps, logHits, system: sysCache || {}, others: s.others || [],
    crashHandler: handlers,
    modules: (s.modules || []).map((m) => m.replace(/^.*[\\/]/, "")).slice(0, 400), localDumps: ld && ld.ok ? { on: !!ld.on } : null, scan: sc && sc.result ? { dirs: sc.result.dirs, ms: sc.result.ms, tokens } : null };
  if (!LINUX && exit && exit.how !== "lost" && exit.code !== 0) { try { report.ansiNames = ansiNames(s, s.start); } catch (e) { alog("names check: " + e.message); } }
  // files a crash leaves behind, even when the dump itself can't be read: any dump, or anything from a crash reporter's folder
  { const st = steamApp(s.path); if (st) { report.game.steam = st.id; if (LINUX) { const pv = protonOf(st); if (pv) report.game.proton = pv; } } }
  report.crashFiles = files.filter((f) => f.name && (/\.(dmp|mdmp|hdmp)$/i.test(f.name) || /crashcontext|[\\/]crashes[\\/]|[\\/]crashreport|crashdumps[\\/]|[\\/]crash_?reports?[\\/]/i.test(f.orig || ""))).map((f) => f.name).slice(0, 12);
  const a = A.analyze(report);
  report.verdict = { kind: a.kind, title: a.title, why: a.why, module: a.module, errName: a.errName };
  alog(`${s.exe} read as "${a.kind}" (${a.title}); files ${files.filter((f) => f.name).length}, dumps ${dumps.length}, log lines ${logHits.length}, folders searched ${sc && sc.result ? sc.result.dirs : "?"}, tokens ${tokens.join(",")}`);
  if (a.kind === "normal" && !CFG.keepNormal && !lost) { try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {} g.lastOk = end; g.sessions = (g.sessions || 0) + 1; saveCfg(); tell("diag-update"); tell("diag-closed", { name: g.name }); return; }
  fs.mkdirSync(s.folder, { recursive: true });
  fs.writeFileSync(path.join(s.folder, "report.json"), JSON.stringify(report));
  fs.writeFileSync(path.join(s.folder, "head.json"), JSON.stringify({ id: report.id, game: g.name, exe: s.exe, key: s.key, start: s.start, end, kind: a.kind, title: a.title, why: a.why.slice(0, 300), module: a.module || "", gpu: (mainGpu(report.system) || {}).name || "", drv: (mainGpu(report.system) || {}).driver || "", osb: (report.system || {}).osBuild || (report.system || {}).osVersion || "", files: files.filter((f) => f.name).length }));
  try { fs.writeFileSync(path.join(s.folder, "summary.txt"), A.summaryText(report, a)); fs.unlinkSync(path.join(s.folder, "live.json")); } catch {}
  if (a.kind !== "normal") { g.crashes = (g.crashes || 0) + 1; g.lastCrash = end; g.lastKind = a.kind; }
  g.sessions = (g.sessions || 0) + 1; saveCfg(); prune(g);
  log("report: " + g.name + " -> " + a.kind + " (" + a.title + "), " + files.length + " files, " + events.length + " events");
  tell("diag-update"); tell("diag-report-ready", { id: report.id, name: g.name, title: a.title, kind: a.kind });
  if (CFG.notify && a.kind !== "normal" && Notification.isSupported()) { try { const n = new Notification({ title: g.name + ": " + a.title, body: a.why.slice(0, 180), icon: path.join(__dirname, "icon.png") }); n.on("click", () => { const w = getWin(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); tell("diag-open", report.id); } }); n.show(); } catch {} }
}
function listReports() {
  const out = [];
  try { for (const g of fs.readdirSync(DATA)) { if (g.startsWith("_")) continue; const gd = path.join(DATA, g); let subs = []; try { if (!fs.statSync(gd).isDirectory()) continue; subs = fs.readdirSync(gd); } catch { continue; }
    for (const d of subs) { try { out.push(JSON.parse(fs.readFileSync(path.join(gd, d, "head.json"), "utf8"))); } catch {} } } } catch {}
  return out.sort((a, b) => b.end - a.end);
}
function prune(g) { const mine = listReports().filter((r) => r.exe && keyOf(r.exe) === keyOf(g.exe)); for (const r of mine.slice(Math.max(3, CFG.keep || 25))) { try { fs.rmSync(folderOf(r.id), { recursive: true, force: true }); } catch {} } }
function folderOf(id) { const f = path.resolve(DATA, String(id || "")); if (!f.toLowerCase().startsWith(path.resolve(DATA).toLowerCase() + path.sep) || /(^|[\\/])\.\.([\\/]|$)/.test(String(id))) throw new Error("bad report"); return f; }

/* ---------------------------------------------------------------- what the page can ask */
function state() {
  const reports = listReports(), byKey = {};
  for (const r of reports) { const k = r.key || keyOf(r.exe); (byKey[k] = byKey[k] || []).push(r); }
  const games = Object.entries(CFG.games).map(([key, g]) => { const s = [...live.values()].find((x) => x.key === key); const rs = byKey[key] || [];
    return { key, exe: g.exe, name: g.name, path: g.path || "", watch: g.watch !== false, how: g.how || "", lastSeen: g.lastSeen || 0, sessions: g.sessions || 0, reports: rs.length, last: rs[0] ? { id: rs[0].id, kind: rs[0].kind, title: rs[0].title, end: rs[0].end } : null,
      running: s ? { pid: s.pid, since: s.start, title: s.title, cpu: s.last ? s.last.cpu : -1, pm: s.last ? s.last.pm : -1, gpu: s.last ? s.last.gpu : -1, vram: s.last ? s.last.vram : -1, gt: s.last ? s.last.gt : -1, hung: s.last ? s.last.hung : 0 } : null };
  }).sort((a, b) => (!!b.running - !!a.running) || (b.lastSeen - a.lastSeen));
  return { ok: process.platform === "win32" || LINUX, helper: helperOk, games, reports: reports.slice(0, 300), settings: { auto: CFG.auto, keepNormal: CFG.keepNormal, keep: CFG.keep, interval: CFG.interval, notify: CFG.notify, startup: CFG.startup }, ignore: CFG.ignore, folder: DATA };
}
function applyStartup() { try { AUTOSTART.set(app, !!CFG.startup || !!(CFG.pc && CFG.pc.keepAlive)); } catch {} }
let quitting = false;
exports.start = function (o) {
  loadSync(); setTimeout(() => syncNow(), 4000); setInterval(() => syncNow(), 10 * 60 * 1000);       // the lists follow the account: at start, after each change, and every ten minutes
  getWin = o.getWin; log = o.log || (() => {});
  try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
  app.on("before-quit", () => { quitting = true; try { if (helper) helper.stdin.write('{"cmd":"quit"}\n'); } catch {} });
  PC.start({ ask, tell, alog, cfg: () => CFG, save: () => saveCfg(true), helperOk: () => helperOk, games: () => Object.keys(CFG.games), DATA, getWin: () => getWin(), helperPath });
  startHelper();
  setTimeout(() => closeLost().catch(() => {}), 20000);        // after the first look for games that are still running
  ipcMain.handle("diag-state", () => state());
  ipcMain.handle("diag-procs", async () => { const r = await ask("procs", {}, 15000); return r && r.ok ? r.list : []; });
  ipcMain.handle("diag-add", async (_e, a) => {
    a = a || {};
    if (a.pid) { const r = await ask("attach", { pid: a.pid | 0 }); if (!r.ok) return r; const s = live.get(a.pid | 0); if (s && CFG.games[s.key]) { CFG.games[s.key].how = "you"; CFG.games[s.key].watch = true; CFG.ignore = CFG.ignore.filter((x) => x !== s.key); saveCfg(); pushWatch(); } return { ok: true }; }
    let file = a.path;
    if (!file) { const { dialog } = require("electron"); const r = await dialog.showOpenDialog(getWin(), LINUX ? { title: "Choose the game's program", properties: ["openFile"] } : { title: "Choose the game's program (.exe)", properties: ["openFile"], filters: [{ name: "Programs", extensions: ["exe"] }] }); if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true }; file = r.filePaths[0]; }
    const exe = path.basename(String(file)), key = keyOf(exe); if (!LINUX && !/\.exe$/i.test(exe)) return { ok: false, error: "Choose the game's .exe file." };
    CFG.games[key] = Object.assign({ exe, name: prettyName(exe), added: Date.now() }, CFG.games[key] || {}, { path: file, watch: true, how: "you" }); CFG.ignore = CFG.ignore.filter((x) => x !== key); saveCfg(); pushWatch();
    ask("verinfo", { path: file }).then((v) => { if (v && v.ok) { const nice = (v.product || v.description || "").trim(); if (nice.length >= 3 && nice.length <= 60 && !CFG.games[key].named) { CFG.games[key].name = nice; CFG.games[key].named = true; saveCfg(); tell("diag-update"); } } });
    return { ok: true };
  });
  ipcMain.handle("diag-game", async (_e, a) => {
    const g = CFG.games[a && a.key]; if (!g) return { ok: false };
    if (typeof a.watch === "boolean") { g.watch = a.watch; if (!a.watch) for (const s of [...live.values()]) if (s.key === a.key) { ask("detach", { pid: s.pid }); lose(s); try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {} } }
    if (typeof a.name === "string" && a.name.trim()) { g.name = a.name.trim().slice(0, 60); g.named = true; }
    if (a.remove) { for (const s of [...live.values()]) if (s.key === a.key) { ask("detach", { pid: s.pid }); lose(s); try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {} } delete CFG.games[a.key]; if (!CFG.ignore.includes(a.key)) CFG.ignore.push(a.key); }
    saveCfg(); pushWatch(); return { ok: true };
  });
  ipcMain.handle("diag-hide", (_e, exe) => {          // from the "which one is the game?" list: never show or watch this program
    const key = keyOf(path.basename(String(exe || ""))); if (!key) return { ok: false };
    for (const s of [...live.values()]) if (s.key === key) { ask("detach", { pid: s.pid }); lose(s); try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {} }
    delete CFG.games[key]; if (!CFG.ignore.includes(key)) CFG.ignore.push(key);
    saveCfg(); pushWatch(); return { ok: true };
  });
  ipcMain.handle("diag-sync", async (_e, what, a) => {
    try {
      if (what === "login") {
        a = a || {}; SY.server = /^https?:\/\//.test(String(a.server || "")) ? String(a.server).trim() : SYNC_DEFAULT; SY.token = ""; SY.at = 0; SY.cursor = 0; SY.base = null;
        const r = await sapi("POST", "/login", { user: a.user, pass: a.pass, device: SY.device, deviceName: "aGoldenDiagnose on " + os.hostname() });
        SY.token = r.token; SY.user = r.user || a.user; saveSync(); await syncNow(); if (SY.error) return { ok: false, error: SY.error };
      } else if (what === "logout") { try { await sapi("POST", "/logout"); } catch {} SY.token = ""; SY.at = 0; SY.base = null; SY.error = ""; saveSync(); }
      else if (what === "now") { await syncNow(); if (SY.error) return { ok: false, error: SY.error }; }
      return { ok: true, signedIn: !!SY.token, user: SY.user, server: SY.server, at: SY.at, error: SY.error };
    } catch (e) { return { ok: false, error: e.message, signedIn: !!SY.token, user: SY.user, server: SY.server, at: SY.at }; }
  });
  ipcMain.handle("diag-unignore", (_e, key) => { CFG.ignore = CFG.ignore.filter((x) => x !== key); saveCfg(); pushWatch(); return { ok: true }; });
  ipcMain.handle("diag-settings", (_e, v) => { for (const k of ["auto", "keepNormal", "notify", "startup"]) if (typeof v[k] === "boolean") CFG[k] = v[k]; if (v.keep) CFG.keep = Math.max(3, Math.min(200, v.keep | 0)); if (v.interval) CFG.interval = Math.max(1000, Math.min(10000, v.interval | 0)); saveCfg(); pushWatch(); applyStartup(); return state().settings; });
  ipcMain.handle("diag-report", (_e, id) => {
    try {
      const f = folderOf(id), report = JSON.parse(fs.readFileSync(path.join(f, "report.json"), "utf8"));
      let rows = []; try { rows = fs.readFileSync(path.join(f, "timeline.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
      // the whole session thinned to about 600 points, plus every sample of its last 5 minutes
      const lastT = rows.length ? rows[rows.length - 1][0] : 0, tail = rows.filter((r) => r[0] >= lastT - 300000), step = Math.max(1, Math.ceil(rows.length / 600));
      return { ok: true, report, timeline: rows.filter((_, i) => i % step === 0), tail, folder: f };
    } catch (e) { return { ok: false, error: "That report couldn't be opened (" + e.message + ")." }; }
  });
  ipcMain.handle("diag-file", (_e, id, name) => { try { const f = path.join(folderOf(id), "files", path.basename(String(name))); const st = fs.statSync(f); return { ok: true, text: isText(name) ? readText(f, 3e6) : "", binary: !isText(name), size: st.size }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle("diag-delete", (_e, id) => { try { fs.rmSync(folderOf(id), { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; } tell("diag-update"); return { ok: true }; });
  ipcMain.handle("diag-folder", (_e, id) => { try { return shell.openPath(id ? folderOf(id) : DATA); } catch { return ""; } });
  ipcMain.handle("diag-linux", (_e, what, a) => {          // Settings > Linux
    if (!RUN) return { ok: false, error: "Linux only" };
    if (what === "setup") return RUN.setup();
    if (what === "proton") return RUN.proton(!!(a && a.on));
    if (what === "menu") return RUN.menu(!!(a && a.on), path.join(__dirname, "icon.png"));
    return RUN.state();
  });
  ipcMain.handle("diag-export", async (_e, id) => {
    let tmp = "";
    try { const f0 = folderOf(id); let f = f0;
      if (SHARED) {          // ask whether to hide the user name and PC name in the .zip (the report on this PC stays as it is)
        const { dialog } = require("electron");
        const q = await dialog.showMessageBox(getWin(), { type: "question", title: "aGoldenDiagnose", noLink: true, defaultId: 0, cancelId: 2, buttons: ["Hide them", "Keep everything as it is", "Cancel"],
          message: "Hide your user name and PC name in the .zip?", detail: "Game logs and reports often contain your user name (inside folder paths) and your PC's name. Hiding them replaces them with ***** in every file of the .zip. The report kept on this PC isn't changed." });
        if (q.response === 2) return { ok: false, cancelled: true };
        if (q.response === 0) { tmp = path.join(os.tmpdir(), "agd-export-" + process.pid + "-" + Date.now()); redactCopy(f0, tmp); f = tmp; }
      }
      const head = JSON.parse(fs.readFileSync(path.join(f, "head.json"), "utf8")), dir = path.join(app.getPath("downloads"), "aGoldenDiagnose"); fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, safe(head.game) + " " + stamp(head.end) + ".zip"); const r = await ask("zip", { dir: f, out }, 180000); if (!r.ok) return r; shell.showItemInFolder(out); return { ok: true, path: out, size: r.size, hidden: !!tmp };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  });
  ipcMain.handle("diag-tools", async (_e, what, a) => {
    a = a || {};
    const rep = () => { try { return JSON.parse(fs.readFileSync(path.join(folderOf(String(a.id || "")), "report.json"), "utf8")); } catch { return null; } };
    if (what === "hide") return { text: hideNames(a.text) };
    const r = rep(), st = r ? (r.game.steam ? { id: String(r.game.steam), lib: steamApp(r.game.path) ? steamApp(r.game.path).lib : "" } : steamApp(r.game.path)) : null;
    if (what === "verify") {
      if (!st || !/^\d+$/.test(st.id)) return { ok: false, error: "This game isn't in a Steam library, so Steam can't check its files." };
      await shell.openExternal("steam://validate/" + st.id); alog("verify asked of Steam for app " + st.id);
      return { ok: true };
    }
    if (what === "shaders") {
      return { ok: true, dirs: shaderDirs(st && st.lib ? st : null).map(([name, d]) => Object.assign({ name, path: d }, dirSize(d))).filter((x) => x.files > 0) };
    }
    if (what === "shaders-clear") {
      let freed = 0, kept = 0; for (const [, d] of shaderDirs(st && st.lib ? st : null)) { const c = clearDir(d); freed += c.freed; kept += c.kept; }
      alog("shader caches cleared: " + Math.round(freed / 1048576) + " MB freed, " + kept + " files in use left");
      return { ok: true, freed, kept };
    }
    return { ok: false, error: "unknown" };
  });
  ipcMain.handle("diag-dumps", async (_e, exe, on) => { const name = path.basename(String(exe)); const r = await ask("localdumps", { exe: name, mode: on === null ? "get" : on ? "on" : "off", dir: DUMP_DIR, elevate: 1 }, 60000); return r; });
  // Settings > AI: Claude through the user's own sync server (its AI gateway holds the key and the budget).
  // Only when signed in to it; the shared copy has no server set, so there it's whatever the user sets up themselves.
  ipcMain.handle("diag-ai", async (_e, what, request) => {
    const can = !!(SY.server && SY.token);
    if (what === "can") return { can, shared: SHARED };
    if (!can) return { ok: false, error: "not-signed-in" };
    try {
      const r = await fetch(SY.server.replace(/\/+$/, "") + "/ai/messages", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SY.token },
        body: JSON.stringify({ app: "agoldendiagnose", request }), signal: AbortSignal.timeout(300000) });
      return { ok: true, status: r.status, body: await r.text() };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // Settings > AI: only ever to Anthropic's API, or to a local AI model (Ollama) on this same PC
  ipcMain.handle("http-post", async (_e, url, headers, body) => {
    if (!/^https:\/\/api\.anthropic\.com\//.test(String(url)) && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/api\/chat$/.test(String(url))) return { ok: false, error: "not-allowed" };
    try { const r = await fetch(url, { method: "POST", headers: headers || {}, body: String(body || ""), signal: AbortSignal.timeout(180000) }); return { ok: true, status: r.status, body: await r.text() }; } catch (e) { return { ok: false, error: "network" }; }
  });
  applyStartup();
  if (RUN) setInterval(() => { try { const r = RUN.scan(); if ((r.changed || r.active.length) && helperOk) ask("runs", { pids: r.active }); for (const x of r.orphans) reportRun(x); } catch (e) { log("runs: " + e.message); } }, 3000);
};
/* A copy of a report with the user name, the home folder's name and the PC's name replaced by stars of the same length,
 * in every file (text and crash dumps alike; same length, so no file's layout changes). */
/* ---------------------------------------------------------------- tools on a report (Steam, shader caches, sharing) */
/** The main graphics card: the one with the most video memory, leaving out Windows' basic and remote-desktop ones. */
function mainGpu(sys) {
  const g = ((sys && sys.gpus) || []).filter((x) => x && x.name && !/basic|remote|virtual|parsec|meta virtual|indirect/i.test(x.name)).sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0];
  return g ? { name: g.name, driver: g.driver || "" } : null;
}
/** A game inside a Steam library: its app id (from the library's appmanifest files) and the library folder. */
function steamApp(gamePath) {
  const p = String(gamePath || "").replace(/\\/g, "/"), m = /^(.*\/steamapps)\/common\/([^/]+)\//i.exec(p);
  if (!m) return null;
  const lib = LINUX ? m[1] : m[1].replace(/\//g, "\\");
  try {
    for (const f of fs.readdirSync(lib)) {
      const mm = /^appmanifest_(\d+)\.acf$/i.exec(f); if (!mm) continue;
      const d = /"installdir"\s+"([^"]+)"/i.exec(fs.readFileSync(path.join(lib, f), "utf8"));
      if (d && d[1].toLowerCase() === m[2].toLowerCase()) return { id: mm[1], lib };
    }
  } catch {}
  return null;
}
/** The Proton version a Steam game ran with on Linux (Proton writes it in the game's compatdata folder). */
function protonOf(st) {
  if (!st) return "";
  const dir = path.join(st.lib, "compatdata", st.id);
  try { const c = fs.readFileSync(path.join(dir, "config_info"), "utf8").split("\n")[0].trim(); if (c && c.length < 60) return c; } catch {}
  try { const v = fs.readFileSync(path.join(dir, "version"), "utf8").trim(); if (v && v.length < 60) return v; } catch {}
  return "";
}
/** The shader caches the graphics drivers keep, and this game's own one in Steam: they're rebuilt by themselves. */
function shaderDirs(st) {
  const H = os.homedir(), out = [];
  if (LINUX) { const C = process.env.XDG_CACHE_HOME || path.join(H, ".cache"); out.push(["NVIDIA (OpenGL / Vulkan)", path.join(C, "nvidia", "GLCache")], ["Mesa (AMD and Intel)", path.join(C, "mesa_shader_cache")], ["Mesa (AMD and Intel)", path.join(C, "mesa_shader_cache_db")]); }
  else {
    const L = process.env.LOCALAPPDATA || path.join(H, "AppData", "Local");
    out.push(["NVIDIA (DirectX)", path.join(L, "NVIDIA", "DXCache")], ["NVIDIA (OpenGL / Vulkan)", path.join(L, "NVIDIA", "GLCache")], ["NVIDIA", path.join(process.env.ProgramData || "C:\\ProgramData", "NVIDIA Corporation", "NV_Cache")],
      ["AMD (DirectX)", path.join(L, "AMD", "DxCache")], ["AMD (DirectX 12)", path.join(L, "AMD", "DxcCache")], ["AMD (Vulkan)", path.join(L, "AMD", "VkCache")], ["AMD (OpenGL)", path.join(L, "AMD", "GLCache")],
      ["Intel", path.join(L, "Intel", "ShaderCache")], ["Windows (DirectX)", path.join(L, "D3DSCache")]);
  }
  if (st) out.push(["This game's Steam shader cache", path.join(st.lib, "shadercache", st.id)]);
  return out;
}
function dirSize(d) { let n = 0, c = 0; const walk = (x) => { let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of es) { const y = path.join(x, e.name); if (e.isDirectory()) walk(y); else { try { n += fs.statSync(y).size; c++; } catch {} } } }; walk(d); return { bytes: n, files: c }; }
function clearDir(d) { let freed = 0, kept = 0; const walk = (x) => { let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of es) { const y = path.join(x, e.name); if (e.isDirectory()) { walk(y); try { fs.rmdirSync(y); } catch {} } else { let sz = 0; try { sz = fs.statSync(y).size; fs.rmSync(y, { force: true }); freed += sz; } catch { kept++; } } } }; walk(d); return { freed, kept }; }
/** Replace the user name, the home folder's name and the PC's name with stars (for text shared on Discord). */
function hideNames(text) {
  const words = [...new Set([os.userInfo().username, path.basename(os.homedir()), os.hostname()].filter((w) => w && w.length >= 3))].sort((a, b) => b.length - a.length);
  let t = String(text || ""); for (const w of words) t = t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "*".repeat(w.length));
  return t;
}

function redactCopy(from, to) {
  const words = [...new Set([os.userInfo().username, path.basename(os.homedir()), os.hostname()].filter((w) => w && w.length >= 3))].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = []; for (const w of words) { const b = Buffer.from(w, "utf8").toString("latin1"), u = Buffer.from(w, "utf16le").toString("latin1"); res.push([new RegExp(esc(b), "gi"), "*".repeat(b.length)], [new RegExp(u.split("").map(esc).join(""), "gi"), "*\0".repeat(w.length)]); }
  const walk = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const e of fs.readdirSync(a, { withFileTypes: true })) { const x = path.join(a, e.name), y = path.join(b, e.name); if (e.isDirectory()) walk(x, y); else if (e.isFile()) { let t = fs.readFileSync(x).toString("latin1"); for (const [re, to] of res) t = t.replace(re, to); fs.writeFileSync(y, Buffer.from(t, "latin1")); } } };
  walk(from, to);
}
exports.liveCount = () => live.size;
