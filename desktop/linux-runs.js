/* Linux: games started through the Steam launch option, and the app's place in the applications menu.
 *
 * Linux doesn't tell an outside program how a game ended. A program that starts the game itself does learn it, so
 * Settings can set up a small script to use as a game's launch option in Steam:   "<the script>" %command%
 * For each run the script writes three small files in ~/.local/share/aGoldenDiagnose/runs:
 *   <id>.json   when it started and ended, and the exit code      <id>.args   the command Steam gave it
 *   <id>.log    what the game printed                              <id>.prefix the game's Proton folder, if any
 * The app reads them for the report and then deletes them (anything left is removed after 7 days). The script
 * starts nothing else and sends nothing anywhere: it is written out in full below, and saved as a plain text file.
 */
const fs = require("fs"), os = require("os"), path = require("path");

const BASE = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "aGoldenDiagnose");
const RUNS = path.join(BASE, "runs"), SCRIPT = path.join(BASE, "agd-run.sh"), PROTON_FLAG = path.join(BASE, "proton-log.on");
const MENU = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "applications", "aGoldenDiagnose.desktop"), MENU_ICON = path.join(BASE, "icon.png");
const WEEK = 7 * 86400000;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
exports.dir = RUNS;

function script() {
  return `#!/bin/sh
# aGoldenDiagnose: starts a game for Steam and notes how it ended.
# Use it as the game's launch option in Steam (Properties > General > Launch options):
#   "${SCRIPT}" %command%
# For each run it writes, in the folder below: when the game started and ended and its exit code (.json), the command
# Steam gave (.args), the game's Proton folder if it has one (.prefix) and what the game printed (.log).
# Nothing else, and nothing is sent anywhere. aGoldenDiagnose reads them for its report, then deletes them.
dir=${shq(RUNS)}
mkdir -p "$dir" 2>/dev/null
id="$(date +%s)-$$"
start="$(date +%s)000"
printf '{"pid":%s,"start":%s}\\n' "$$" "$start" > "$dir/$id.json" 2>/dev/null
for a in "$@"; do printf '%s\\n' "$a"; done > "$dir/$id.args" 2>/dev/null
printf '%s\\n' "$STEAM_COMPAT_DATA_PATH" > "$dir/$id.prefix" 2>/dev/null
# Proton's own detailed log, only when it is turned on in aGoldenDiagnose's Settings
if [ -f ${shq(PROTON_FLAG)} ]; then PROTON_LOG=1; PROTON_LOG_DIR="$dir"; export PROTON_LOG PROTON_LOG_DIR; fi
"$@" > "$dir/$id.log" 2>&1
code=$?
printf '{"pid":%s,"start":%s,"end":%s000,"code":%s}\\n' "$$" "$start" "$(date +%s)" "$code" > "$dir/$id.json.tmp" 2>/dev/null && mv -f "$dir/$id.json.tmp" "$dir/$id.json"
exit $code
`;
}

/* ---------------------------------------------------------------- Settings */
exports.state = () => ({ ok: true, script: fs.existsSync(SCRIPT), proton: fs.existsSync(PROTON_FLAG), menu: fs.existsSync(MENU), appimage: !!process.env.APPIMAGE, option: '"' + SCRIPT + '" %command%' });
exports.setup = () => {
  try { fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(SCRIPT, script()); fs.chmodSync(SCRIPT, 0o755); return { ok: true, option: '"' + SCRIPT + '" %command%', file: SCRIPT }; }
  catch (e) { return { ok: false, error: "The script couldn't be written (" + e.message + ")." }; }
};
exports.proton = (on) => { try { if (on) { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(PROTON_FLAG, "Proton's own log is on for games started with the launch option.\n"); } else fs.rmSync(PROTON_FLAG, { force: true }); return exports.state(); } catch (e) { return { ok: false, error: e.message }; } };
exports.menu = (on, iconFrom) => {
  try {
    if (!on) { fs.rmSync(MENU, { force: true }); fs.rmSync(MENU_ICON, { force: true }); return exports.state(); }
    const exe = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(BASE, { recursive: true }); try { fs.copyFileSync(iconFrom, MENU_ICON); } catch {}
    fs.mkdirSync(path.dirname(MENU), { recursive: true });
    fs.writeFileSync(MENU, ["[Desktop Entry]", "Type=Application", "Name=aGoldenDiagnose", "Comment=Watches your games and gathers everything about a crash into one report", 'Exec="' + exe.replace(/(["\\`$])/g, "\\$1") + '" %U', "Icon=" + MENU_ICON, "Terminal=false", "Categories=Utility;System;", ""].join("\n"));
    return exports.state();
  } catch (e) { return { ok: false, error: "The menu entry couldn't be written (" + e.message + ")." }; }
};

/* ---------------------------------------------------------------- the runs */
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
function list() {
  let names = []; try { names = fs.readdirSync(RUNS); } catch { return []; }
  const out = [];
  for (const n of names) { const m = /^(\d+-\d+)\.json$/.exec(n); if (!m) continue; try { const j = JSON.parse(read(path.join(RUNS, n))); if (j && j.pid) { j.id = m[1]; out.push(j); } } catch {} }
  return out;
}
const claimed = new Set();
let lastActive = "";
/** Every few seconds: which runs are going on (their games are watched even when watching by itself is off), and which
 *  ended without the app watching them (a report is made from what they left behind). Old leftovers are removed. */
exports.scan = () => {
  const now = Date.now(), runs = list(), active = runs.filter((r) => !r.end).map((r) => r.pid).sort();
  const key = active.join(","), changed = key !== lastActive; lastActive = key;
  const orphans = [];
  for (const r of runs) {
    if (claimed.has(r.id)) continue;
    if (!r.end && now - r.start > 2 * 86400000) { exports.done(r); continue; }          // the script was ended along with the game: nothing more to learn
    if (!r.end || now - r.end < 25000) continue;
    claimed.add(r.id);
    if (Number(r.code) === 0) exports.done(r); else orphans.push(r);
  }
  try { for (const n of fs.readdirSync(RUNS)) { const f = path.join(RUNS, n); try { if (now - fs.statSync(f).mtimeMs > WEEK) fs.rmSync(f, { force: true }); } catch {} } } catch {}
  return { changed, active, orphans };
};
/** The run a watched game belongs to (the script is one of its parent processes), once the run has ended. */
exports.waitFor = async (anc) => {
  const set = new Set((anc || []).map(Number));
  let r = list().find((x) => set.has(Number(x.pid)) && !claimed.has(x.id)); if (!r) return null;
  claimed.add(r.id);
  for (let i = 0; i < 40 && !r.end; i++) { await new Promise((ok) => setTimeout(ok, 250)); const again = list().find((x) => x.id === r.id); if (again) r = again; }
  return r.end ? r : null;
};
const SIG = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM" };
// the same crash, in the Windows codes the reading of a report already knows
const AS_CODE = { 4: 0xC000001D, 5: 0x80000003, 6: 0xC0000409, 7: 0xC0000006, 8: 0xC0000094, 11: 0xC0000005 };
const hex = (n) => "0x" + (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");
exports.exit = (r) => {
  const raw = Number(r.code) || 0, sig = raw > 128 && raw <= 192 ? raw - 128 : 0;
  if (sig && SIG[sig]) { const code = AS_CODE[sig] !== undefined ? AS_CODE[sig] : raw; return { code, hex: hex(code), signal: SIG[sig], raw, unknown: false, via: "launch option" }; }
  return { code: raw, hex: hex(raw), signal: "", raw, unknown: false, via: "launch option" };
};
/** The game a run started: the .exe for a Proton game, otherwise the program after Steam's own helpers. */
exports.gameOf = (r) => {
  const args = read(path.join(RUNS, r.id + ".args")).split("\n").filter(Boolean);
  const prefix = (read(path.join(RUNS, r.id + ".prefix")).trim()), pfx = prefix ? path.join(prefix, "pfx") : "";
  const exe = args.filter((a) => /\.exe$/i.test(a)).pop();
  if (exe) return { name: path.basename(exe.replace(/\\/g, "/")), path: exe, prefix: pfx, wine: true };
  const SKIP = /\/reaper$|steam-launch-wrapper|_v2-entry-point|pressure-vessel|\/proton$|steamlinuxruntime|ubuntu12_(32|64)|steam-runtime|\/bin\/(sh|bash|env)$/i;
  let after = args.lastIndexOf("--"); const tail = after >= 0 ? args.slice(after + 1) : args;
  const prog = tail.find((a) => a.startsWith("/") && !SKIP.test(a) && fs.existsSync(a)) || args.find((a) => a.startsWith("/") && !SKIP.test(a) && fs.existsSync(a));
  return prog ? { name: path.basename(prog), path: prog, prefix: "", wine: false } : null;
};
/** Files a run adds to the report: what the game printed. */
exports.files = (r) => { const f = path.join(RUNS, r.id + ".log"); try { const st = fs.statSync(f); return st.size ? [{ path: f, size: st.size, mtime: Math.round(st.mtimeMs), kind: "game-log" }] : []; } catch { return []; } };
exports.done = (r) => {
  if (!r || !r.id) return;
  for (const ext of [".json", ".args", ".log", ".prefix", ".json.tmp"]) fs.rmSync(path.join(RUNS, r.id + ext), { force: true });
  // Proton's own log of that run (it was copied into the report)
  try { for (const n of fs.readdirSync(RUNS)) { if (!/^steam-\d+\.log$/.test(n)) continue; const f = path.join(RUNS, n), t = fs.statSync(f).mtimeMs; if (t >= (r.start || 0) - 5000 && t <= (r.end || Date.now()) + 120000) fs.rmSync(f, { force: true }); } } catch {}
};
