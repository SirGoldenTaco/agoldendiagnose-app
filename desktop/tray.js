/* "Minimize to the system tray" and "Close to the system tray": two switches.
 * On: the minimize button / the X hides the window next to the clock instead of the taskbar / instead of quitting.
 * The choice is kept in tray.json beside the app's other data. Apps that already have a tray icon reuse it. */
const { app, Tray, Menu, nativeImage, ipcMain } = require("electron");
const fs = require("fs"), path = require("path");

let beforeQuit = null;      // an app can ask "really quit?": return false to stay
let on = false, closeOn = false, closeDefault = false, quitting = false, own = null, win = null, appTray = () => null, name = "", appManaged = false;
const file = () => path.join(app.getPath("userData"), "tray.json");
function load() { let j = {}; try { j = JSON.parse(fs.readFileSync(file(), "utf8")) || {}; } catch {} on = !!j.min; closeOn = j.close === undefined ? closeDefault : !!j.close; }
function save() { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify({ min: on, close: closeOn })); } catch {} }
function show() { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
// An app that has its own tray icon makes it a moment after its window: this one must never be added beside it.
// For those apps an icon is only made here as a last resort, at the moment the window is about to be hidden with no icon to bring it back.
function sync(lastResort) {
  const theirs = appTray();
  const want = on || closeOn;
  if (own && (theirs || !want)) { try { own.destroy(); } catch {} own = null; }
  if (want && !theirs && !own && (!appManaged || lastResort)) {
    try {
      own = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
      own.setToolTip(name);
      own.on("click", show);
      own.setContextMenu(Menu.buildFromTemplate([{ label: "Show " + name, click: show }, { type: "separator" }, { label: "Quit", click: () => { if (beforeQuit && !beforeQuit("tray")) return; quitting = true; try { own.destroy(); } catch {} own = null; app.quit(); } }]));
    } catch { own = null; }
  }
}

const M1 = "Minimize to the system tray", M2 = "the minimize button hides the window next to the clock", C1 = "Close to the system tray", C2 = "the X hides the window instead of quitting; quit from the icon next to the clock";
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1) + ".";
const ROW = {
  toggle: `<label class="toggle"><input type="checkbox" data-k="min"> ${M1} <span class="dim">(${M2})</span></label><label class="toggle"><input type="checkbox" data-k="close"> ${C1} <span class="dim">(${C2})</span></label>`,
  card: `<div class="card"><b>Window</b><label class="toggle"><input type="checkbox" data-k="min"> ${M1} <span class="dim">(${M2})</span></label><label class="toggle"><input type="checkbox" data-k="close"> ${C1} <span class="dim">(${C2})</span></label></div>`,
  sw: `<div class="sw"><div class="t">${M1}<small>${cap(M2)}</small></div><label class="tg"><input type="checkbox" data-k="min"><i></i></label></div><div class="sw"><div class="t">${C1}<small>${cap(C2)}</small></div><label class="tg"><input type="checkbox" data-k="close"><i></i></label></div>`,
  swb: `<div class="sw"><div class="t"><b>${M1}</b><small>${cap(M2)}</small></div><label class="tg"><input type="checkbox" data-k="min"><i></i></label></div><div class="sw"><div class="t"><b>${C1}</b><small>${cap(C2)}</small></div><label class="tg"><input type="checkbox" data-k="close"><i></i></label></div>`,
  row: `<div class="row"><label><input type="checkbox" data-k="min">${M1} (${M2})</label></div><div class="row"><label><input type="checkbox" data-k="close">${C1} (${C2})</label></div>`,
  plain: `<label style="display:flex;align-items:center;gap:8px;margin:8px 0 4px;font-size:13px;opacity:.85;cursor:pointer"><input type="checkbox" data-k="min" style="accent-color:#e3b341"> ${M1}</label><label style="display:flex;align-items:center;gap:8px;margin:4px 0 8px;font-size:13px;opacity:.85;cursor:pointer"><input type="checkbox" data-k="close" style="accent-color:#e3b341"> ${C1}</label>`,
};
// Runs in the app's page: puts the switch into its settings, and puts it back if the page redraws them.
function pageScript(ui) {
  return "(" + function (html, spots) {
    if (!window.trayOpt || window.__trayUi) return; window.__trayUi = 1;
    var state = { min: false, close: false };
    function make() {
      var d = document.createElement("div"); d.id = "trayRow"; d.style.display = "contents"; d.innerHTML = html;
      var all = d.querySelectorAll("input");
      var paint = function () { for (var i = 0; i < all.length; i++) all[i].checked = !!state[all[i].getAttribute("data-k")]; };
      for (var i = 0; i < all.length; i++) (function (c) { c.onchange = function () { var p = {}; p[c.getAttribute("data-k")] = c.checked; window.trayOpt(p).then(function (v) { state = v; paint(); }); }; })(all[i]);
      paint(); return d;
    }
    function place() {
      if (document.getElementById("trayRow")) return;
      for (var i = 0; i < spots.length; i++) {
        var a = document.querySelector(spots[i][0]); if (!a) continue;
        var how = spots[i][1], r = make();
        if (how === "append") a.appendChild(r);
        else if (how.indexOf("after:") === 0) { var p = a.closest(how.slice(6)); (p || a).insertAdjacentElement("afterend", r); }
        else a.insertAdjacentElement("afterend", r);
        return;
      }
    }
    window.trayOpt().then(function (v) { state = v; place(); new MutationObserver(place).observe(document.body, { childList: true, subtree: true }); });
  } + ")(" + JSON.stringify(ROW[ui.row] || ROW.plain) + "," + JSON.stringify(ui.spots) + ")";
}

let wired = false;
/* attach(window, { name, tray: () => the app's own tray icon or null, ui: { row, spots: [[selector, "append" | "after" | "after:<closest>"]] } }) */
/* Where the window was: reopening the app puts it back on the same monitor, at the same place and size (and maximized
   if it was). If that monitor isn't connected any more, the window opens where it normally would. Kept in window.json. */
const placed = new WeakSet();
function placement(w) {
  if (!w || placed.has(w)) return; placed.add(w);
  const { screen } = require("electron"), file = path.join(app.getPath("userData"), "window.json");
  let saved = null; try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { }
  try {
    if (saved && saved.b) {
      const ds = screen.getAllDisplays(), db = saved.db || {};
      const d = ds.find((x) => String(x.id) === String(saved.display) && (!db.width || (x.bounds.width === db.width && x.bounds.height === db.height)))
        || ds.find((x) => x.bounds.x === db.x && x.bounds.y === db.y && x.bounds.width === db.width && x.bounds.height === db.height);
      if (d) {
        const wa = d.workArea, b = saved.b, [mw, mh] = w.getMinimumSize();
        const width = Math.max(mw || 0, Math.min(b.width, wa.width)), height = Math.max(mh || 0, Math.min(b.height, wa.height));
        const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width)), y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
        w.setBounds({ x, y, width, height });
        if (saved.max) { if (w.isVisible()) w.maximize(); else w.once("show", () => { try { w.maximize(); } catch (e) { } }); }
      }
    }
  } catch (e) { }
  let t = 0;
  const write = () => {
    try {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      const max = w.isMaximized(), b = max ? w.getNormalBounds() : w.getBounds(), d = screen.getDisplayMatching(max ? w.getBounds() : b);
      fs.writeFileSync(file, JSON.stringify({ b, max, display: String(d.id), db: d.bounds }));
    } catch (e) { }
  };
  const later = () => { clearTimeout(t); t = setTimeout(write, 500); };
  for (const ev of ["move", "resize", "maximize", "unmaximize"]) w.on(ev, later);
  w.on("close", () => { clearTimeout(t); write(); });
}

/* Keeps this app's icon next to the clock instead of hidden under the ^ after an update. Windows remembers each
   tray icon by the program's path; the portable .exe now always unpacks to the same folder (unpackDirName), and any
   entry Windows still made for this program is set to "shown" (HKCU\Control Panel\NotifyIconSettings, IsPromoted). */
function keepIconShown() {
  if (process.platform !== "win32") return;
  const { execFile } = require("child_process");
  const tail = (path.basename(path.dirname(process.execPath)) + "\\" + path.basename(process.execPath)).toLowerCase();
  const root = "HKCU\\Control Panel\\NotifyIconSettings";
  execFile("reg.exe", ["query", root, "/s"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err || !out) return;
    let key = null, exe = "", promoted = null;
    const done = () => {
      if (key && exe.toLowerCase().endsWith(tail) && promoted !== 1)
        execFile("reg.exe", ["add", key, "/v", "IsPromoted", "/t", "REG_DWORD", "/d", "1", "/f"], { windowsHide: true }, () => {});
    };
    for (const line of String(out).split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) { done(); key = line.trim(); exe = ""; promoted = null; continue; }
      const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === "ExecutablePath") exe = m[2].trim();
      if (m[1] === "IsPromoted") promoted = parseInt(m[2], 16);
    }
    done();
  });
}

exports.attach = function (w, o) {
  o = o || {}; placement(w); win = w; name = o.name || app.getName(); if (o.tray) { appTray = o.tray; appManaged = true; } if (o.closeDefault) closeDefault = true; if (o.beforeQuit) beforeQuit = o.beforeQuit;
  if (!wired) {
    wired = true; load();
    [8000, 60000].forEach((ms) => setTimeout(() => { try { keepIconShown(); } catch {} }, ms));     // once its icon exists
    ipcMain.handle("tray-opt", (_e, v) => {
      if (v && typeof v === "object") { if (typeof v.min === "boolean") on = v.min; if (typeof v.close === "boolean") closeOn = v.close; save(); sync(); }
      return { min: on, close: closeOn };
    });
    app.on("before-quit", () => { quitting = true; if (own) { try { own.destroy(); } catch {} own = null; } });
  }
  sync();
  if (appManaged) [1500, 5000, 15000].forEach((ms) => setTimeout(() => { try { sync(); } catch {} }, ms));      // and remove ours if theirs has appeared since
  w.on("minimize", () => { if (!on) return; sync(true); if (appTray() || own) w.hide(); });
  // apps with their own rule for the X (ownClose) ask exports.close() themselves
  if (!o.ownClose) w.on("close", (e) => { if (quitting) return; if (!closeOn) { if (beforeQuit && !beforeQuit("window")) e.preventDefault(); return; } sync(true); if (appTray() || own) { e.preventDefault(); w.hide(); } });
  if (o.ui) w.webContents.on("did-finish-load", () => { w.webContents.executeJavaScript(pageScript(o.ui)).catch(() => {}); });
};
exports.on = () => on;
exports.close = () => { if (closeOn) sync(true); return closeOn && !!(appTray() || own); };
