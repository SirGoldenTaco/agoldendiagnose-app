const { app, BrowserWindow, ipcMain, net, shell, clipboard } = require("electron");

// Ctrl + / Ctrl - / Ctrl 0 change the text size (the page handles it), instead of Electron's own zoom
app.on("web-contents-created", (_e, wc) => {
  wc.on("before-input-event", (e, i) => {
    if (i.type === "keyDown" && (i.control || i.meta) && !i.alt && ["+", "=", "-", "_", "0"].includes(i.key)) {
      e.preventDefault();
      wc.executeJavaScript(`window.agTextSize && agTextSize.key(${JSON.stringify(i.key)})`).catch(() => {});
    }
  });
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP = "aGoldenDiagnose";
const RELEASES = "https://api.github.com/repos/SirGoldenTaco/agoldendiagnose-app/releases/latest";
const EXE_NAME = process.platform === "linux" ? APP + ".AppImage" : APP + ".exe";          // the file to download from a release

let token = "";
try { token = JSON.parse(fs.readFileSync(path.join(__dirname, "update-config.json"), "utf8")).token || ""; } catch {}
let exeAssetUrl = null;
let win = null;
const startHidden = process.argv.includes("--hidden");          // started with Windows: straight to the tray

if (!require("./single").claim(app, "aGoldenDiagnose")) return;      // one copy at a time: a second one offers to show or force-close the open one
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });      // also brings it back from the tray

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 960, minWidth: 380, minHeight: 500, title: APP, autoHideMenuBar: true, backgroundColor: "#14161a",
    icon: path.join(__dirname, "icon.png"), show: !startHidden,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // The app never leaves its own page: a dropped file or a link must not replace it
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.loadFile(path.join(__dirname, "web", "index.html"));
  // the page crashing or freezing must not leave a dead window: it is loaded again (the watching itself runs outside the page)
  win.webContents.on("render-process-gone", (_e, d) => { if (d && d.reason === "clean-exit") return; setTimeout(() => { try { if (win && !win.isDestroyed()) win.reload(); } catch {} }, 800); });
  win.on("unresponsive", () => { setTimeout(() => { try { if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.reload(); } catch {} }, 15000); });
  // closing the window keeps the app watching from the tray (Settings can turn that off)
  require("./tray").attach(win, { name: "aGoldenDiagnose", closeDefault: false, beforeQuit: (from) => require("./pc").beforeQuit(from), ui: {"row": "sw", "spots": [["#tab-set .card", "append"]]} });
  if (startHidden && !require("./tray").close()) win.show();          // no tray icon to bring it back: don't start hidden
}

ipcMain.handle("app-version", () => app.getVersion());

ipcMain.handle("open-url", (_e, u) => { if (/^https:\/\//.test(String(u))) shell.openExternal(String(u)); });
ipcMain.handle("copy-text", (_e, t) => { try { clipboard.writeText(String(t)); return true; } catch { return false; } });

/* ---- updates from the GitHub release */
// Linux: the app is one AppImage file. The new one is downloaded next to it, then put in its place, and started.
async function installLinux(e) {
  const target = process.env.APPIMAGE;
  if (!target) return { ok: false, error: "not-portable" };
  if (!exeAssetUrl) return { ok: false, error: "no-asset" };
  const tmp = path.join(path.dirname(target), "." + APP + "-update.AppImage");
  try {
    let res = await fetch(exeAssetUrl, { headers: ghHeaders("application/octet-stream"), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) res = await fetch(res.headers.get("location"));
    if (!res.ok) return { ok: false, error: "http-" + res.status };
    const total = Number(res.headers.get("content-length")) || 0, out = fs.createWriteStream(tmp), reader = res.body.getReader();
    let done = 0, last = -1;
    for (;;) { const { done: end, value } = await reader.read(); if (end) break; out.write(Buffer.from(value)); done += value.length; if (total) { const pct = Math.floor((done * 100) / total); if (pct !== last) { last = pct; e.sender.send("update-progress", pct); } } }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, target);
    spawn(target, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch { try { fs.unlinkSync(tmp); } catch {} return { ok: false, error: "network" }; }
}
const parts = (v) => String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
function newer(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; }
// The copy given to other people gets its updates from a public page, which needs no key (the build flips this to true).
const PUBLIC_UPDATES = true;
const ghHeaders = (accept) => Object.assign({ Accept: accept, "User-Agent": APP + (process.platform === "linux" ? "-Linux" : "-Windows"), "X-GitHub-Api-Version": "2022-11-28" }, token ? { Authorization: "Bearer " + token } : {});
ipcMain.handle("update-check", async () => {
  const current = app.getVersion();
  if (!token && !(PUBLIC_UPDATES && RELEASES)) return { ok: false, error: "no-token", current };
  try {
    const res = await fetch(RELEASES, { headers: ghHeaders("application/vnd.github+json") });
    if (!res.ok) return { ok: false, error: "http-" + res.status, current };
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const asset = (rel.assets || []).find((a) => a.name === EXE_NAME);
    exeAssetUrl = asset ? asset.url : null;
    return { ok: true, current, latest, available: !!asset && newer(latest, current) };
  } catch { return { ok: false, error: "network", current }; }
});
ipcMain.handle("update-install", async (e) => {
  if (process.platform === "linux") return installLinux(e);
  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!target) return { ok: false, error: "not-portable" };
  if (!exeAssetUrl) return { ok: false, error: "no-asset" };
  try {
    let res = await fetch(exeAssetUrl, { headers: ghHeaders("application/octet-stream"), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) res = await fetch(res.headers.get("location"));
    if (!res.ok) return { ok: false, error: "http-" + res.status };
    const total = Number(res.headers.get("content-length")) || 0;
    const tmp = path.join(os.tmpdir(), APP + "-update.exe");
    const out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    let done = 0, last = -1;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      out.write(Buffer.from(value)); done += value.length;
      if (total) { const pct = Math.floor((done * 100) / total); if (pct !== last) { last = pct; e.sender.send("update-progress", pct); } }
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    const script = path.join(os.tmpdir(), APP + "-update.cmd");
    fs.writeFileSync(script, ["@echo off", "set tries=0", ":wait", "timeout /t 1 /nobreak >nul",
      `copy /y "${tmp}" "${target}" >nul 2>&1 && goto run`, "set /a tries+=1", "if %tries% lss 60 goto wait", "exit /b 1",
      ":run", `start "" "${target}"`, `del "${tmp}"`, 'del "%~f0"'].join("\r\n"));
    spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch { return { ok: false, error: "network" }; }
});

app.whenReady().then(() => {
  createWindow();
  require("./watch").start({ getWin: () => win, log: (t) => console.log(t) });
});
app.on("window-all-closed", () => app.quit());
