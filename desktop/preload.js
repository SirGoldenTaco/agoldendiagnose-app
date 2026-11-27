const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  version: () => ipcRenderer.invoke("app-version"),
  checkUpdate: () => ipcRenderer.invoke("update-check"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, pct) => cb(pct)),
  copyText: (t) => ipcRenderer.invoke("copy-text", t),
  openUrl: (u) => ipcRenderer.invoke("open-url", u),
  httpPost: (url, headers, body) => ipcRenderer.invoke("http-post", url, headers, body),
  diag: {
    state: () => ipcRenderer.invoke("diag-state"),
    procs: () => ipcRenderer.invoke("diag-procs"),
    add: (a) => ipcRenderer.invoke("diag-add", a),
    game: (a) => ipcRenderer.invoke("diag-game", a),
    unignore: (key) => ipcRenderer.invoke("diag-unignore", key),
    hide: (exe) => ipcRenderer.invoke("diag-hide", exe),
    sync: (what, a) => ipcRenderer.invoke("diag-sync", what, a),
    pc: (what, a) => (["state", "settings", "check", "clear", "folder", "outages", "outagesave", "ignore", "netdiag", "detail", "open", "dismiss"].includes(what) ? ipcRenderer.invoke("pc-" + what, a) : Promise.resolve(null)),
    settings: (v) => ipcRenderer.invoke("diag-settings", v),
    report: (id) => ipcRenderer.invoke("diag-report", id),
    file: (id, name) => ipcRenderer.invoke("diag-file", id, name),
    del: (id) => ipcRenderer.invoke("diag-delete", id),
    folder: (id) => ipcRenderer.invoke("diag-folder", id),
    exportZip: (id) => ipcRenderer.invoke("diag-export", id),
    dumps: (exe, on) => ipcRenderer.invoke("diag-dumps", exe, on),
    tools: (what, a) => ipcRenderer.invoke("diag-tools", what, a),
    ai: (what, request) => ipcRenderer.invoke("diag-ai", what, request),
    linux: (what, a) => ipcRenderer.invoke("diag-linux", what, a),
    on: (ch, cb) => { if (/^diag-(update|live|report-ready|open|building|log|closed)$|^pc-(update|live|open)$/.test(ch)) ipcRenderer.on(ch, (_e, a) => cb(a)); },
  },
});
contextBridge.exposeInMainWorld("trayOpt", (v) => ipcRenderer.invoke("tray-opt", v));
