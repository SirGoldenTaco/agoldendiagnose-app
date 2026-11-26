/* One copy at a time.
 * The first copy takes Electron's lock and notes its process id. A second copy doesn't start: it shows a message
 * saying the app is already open, with a choice to force-close the other copy and open this one instead.
 * Use at the very top of main.js:   if (!require("./single").claim(app, "aGoldenDiagnose")) return;
 * opts.quiet: this launch only hands something to the open copy (no question asked).                        */
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

function pidFile(app) { return path.join(app.getPath("userData"), "running.json"); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function nameOf(pid) {         // the program a process id belongs to, so a reused id never kills something else
  if (process.platform === "linux") { try { return fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim().toLowerCase(); } catch (e) { return ""; } }
  try {
    const out = execFileSync("tasklist.exe", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8", timeout: 8000 });
    const m = /^"([^"]+)"/.exec(out.trim()); return m ? m[1].toLowerCase() : "";
  } catch (e) { return ""; }
}

exports.claim = function (app, name, opts) {
  if (app.requestSingleInstanceLock()) {
    const write = () => { try { fs.mkdirSync(path.dirname(pidFile(app)), { recursive: true }); fs.writeFileSync(pidFile(app), JSON.stringify({ pid: process.pid, exe: path.basename(process.execPath).toLowerCase(), at: Date.now() })); } catch (e) { } };
    write(); app.whenReady().then(write);
    app.on("will-quit", () => { try { const j = JSON.parse(fs.readFileSync(pidFile(app), "utf8")); if (j.pid === process.pid) fs.unlinkSync(pidFile(app)); } catch (e) { } });
    return true;
  }
  // a second copy: the rest of main.js doesn't run. Ask what to do, then leave.
  // started by Windows at sign-in (--hidden) while a copy already runs: nothing to ask, just leave quietly
  // (or opts.quiet: a launch that only passes a message to the open copy, like a taskbar folder opening)
  if (process.argv.includes("--hidden") || (opts && opts.quiet)) { app.exit(0); return false; }
  app.whenReady().then(async () => {
    const { dialog, BrowserWindow } = require("electron");
    let other = null; try { other = JSON.parse(fs.readFileSync(pidFile(app), "utf8")); } catch (e) { }
    const owner = new BrowserWindow({ show: false, alwaysOnTop: true, skipTaskbar: true, width: 1, height: 1 });
    const r = await dialog.showMessageBox(owner, {
      type: "info", title: name, noLink: true, defaultId: 0, cancelId: 2,
      message: name + " is already open.",
      detail: "Only one copy can run at a time. Close the other one first (it may be in the system tray, next to the clock), or force it to close and open this one.",
      buttons: ["Show the open one", "Force close it and open this one", "Cancel"],
    });
    try { owner.destroy(); } catch (e) { }
    if (r.response === 1) {
      const pid = other && other.pid;
      if (pid && pid !== process.pid && alive(pid) && (!other.exe || nameOf(pid) === other.exe || (process.platform === "linux" && other.exe.slice(0, 15) === nameOf(pid)))) {
        if (process.platform === "linux") { try { process.kill(pid, "SIGKILL"); } catch (e) { } }
        else { try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }); } catch (e) { } }
        for (let i = 0; i < 50 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
        try { fs.unlinkSync(pidFile(app)); } catch (e) { }
        // start again from the file you opened (a portable .exe runs from a temporary copy)
        app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath, args: process.argv.slice(1) });
      } else {
        await dialog.showMessageBox({ type: "warning", title: name, message: "The other copy couldn't be found.", detail: "Close it from the system tray (right-click its icon → Quit), or end it in Task Manager, then open " + name + " again.", buttons: ["OK"] });
      }
    }
    app.exit(0);
  });
  return false;
};
