/* Opening the app when you sign in, the normal way for each system: a login item on Windows, and on Linux a small
 * .desktop file in your own autostart folder (~/.config/autostart), which is what desktops read. Turning it off removes it. */
const fs = require("fs"), os = require("os"), path = require("path");
const exe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
exports.exe = exe;
exports.set = function (app, on) {
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart"), file = path.join(dir, "aGoldenDiagnose.desktop");
    if (!on) { try { fs.unlinkSync(file); } catch {} return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, ["[Desktop Entry]", "Type=Application", "Name=aGoldenDiagnose", "Comment=Watches your games and your PC (starts hidden in the tray)", 'Exec="' + exe().replace(/(["\\`$])/g, "\\$1") + '" --hidden', "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n"));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!on, path: exe(), args: ["--hidden"] });
};
