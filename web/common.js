/* Shared helpers for the page.
 * The page sets window.APPCFG = {name, key, server} before loading this file and gives the
 * elements #upd (update bar) and #signin (sign-in card). */
"use strict";
const CFG = window.APPCFG;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtSize = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : (n || 0) + " B";
const fmtTime = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ":" + (s - m * 60).toFixed(2).padStart(5, "0"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- saved settings */
const store = {
  get(k, d) { try { const v = localStorage.getItem(CFG.key + ":" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(CFG.key + ":" + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------------------------------------------------------------- the app's log */
// This copy has no log server: alog() only writes to the window's developer console. Nothing is sent anywhere.
let appVersion = "";
function alog(line) { try { console.info("[aGoldenDiagnose] " + String(line).slice(0, 3000)); } catch (e) {} }
function flushLog() {}
addEventListener("error", (e) => alog("JS error: " + (e.message || "") + " at " + (e.filename || "").split("/").pop() + ":" + e.lineno));
addEventListener("unhandledrejection", (e) => alog("Unhandled: " + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

/* ---------------------------------------------------------------- the app around the page (Windows or Android) */
let cbSeq = 0; const cbs = {};
window.__nativeCb = (id, ok, text) => { const p = cbs[id]; if (p) { delete cbs[id]; let o = null; try { o = JSON.parse(text); } catch (e) { o = text; } p(ok ? o : null); } };
window.__saveProgress = (id, pct) => { const p = cbs["p" + id]; if (p) p(pct); };
function callAndroid(fn, args, ms, onPct) {
  return new Promise((res) => {
    const id = "c" + (++cbSeq); cbs[id] = res;
    if (onPct) cbs["p" + id] = onPct;
    setTimeout(() => { if (cbs[id]) { delete cbs[id]; res(null); } delete cbs["p" + id]; }, ms || 30000);
    window.AndroidNative[fn].apply(window.AndroidNative, (args || []).concat([id]));
  });
}
const NATIVE = {
  kind: window.native ? "e" : window.AndroidNative ? "a" : null,
  async version() { try { return this.kind === "e" ? await window.native.version() : this.kind === "a" ? window.AndroidNative.version() : "web"; } catch (e) { return "?"; } },
  checkUpdate() { return this.kind === "e" ? window.native.checkUpdate().catch(() => null) : this.kind === "a" ? callAndroid("checkUpdate", [], 30000) : Promise.resolve(null); },
  installUpdate() { return this.kind === "e" ? window.native.installUpdate().catch(() => null) : callAndroid("installUpdate", [], 600000); },
  /** Saves a finished file from the server: Windows → Downloads\<App>, Android → Download/<App>. */
  async save(url, name, mime, onPct) {
    if (this.kind === "e") {
      const id = "s" + (++cbSeq);
      const off = window.native.onSaveProgress((sid, pct) => { if (sid === id && onPct) onPct(pct); });
      try { return await window.native.saveUrl(id, url, name); } catch (e) { return { ok: false, error: String(e) }; } finally { if (off) off(); }
    }
    if (this.kind === "a") return (await callAndroid("saveUrl", [url, name, mime || ""], 6 * 3600 * 1000, onPct)) || { ok: false, error: "The app didn't answer." };
    const a = el("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return { ok: true, browser: true };
  },
  open(r, mime) { if (this.kind === "e") window.native.openPath(r.path); else if (this.kind === "a") window.AndroidNative.openUri(r.uri, mime || ""); },
  show(r) { if (this.kind === "e") window.native.showPath(r.path); },
  share(r, mime) { if (this.kind === "a") window.AndroidNative.shareUri(r.uri, mime || ""); },
  folder() { if (this.kind === "e") window.native.openFolder(); },
  sharedFiles() { try { return this.kind === "a" && window.AndroidNative.sharedFiles ? JSON.parse(window.AndroidNative.sharedFiles() || "[]") : []; } catch (e) { return []; } },
};
/** Files shared to the app from another Android app ("Share → aGoldenDiagnose"). */
async function takeSharedFiles() {
  const list = NATIVE.sharedFiles(); const out = [];
  for (const f of list) {
    try { const b = await (await fetch("https://agolden.shared/" + f.i)).blob(); const file = new File([b], f.name || "file", { type: f.mime || b.type }); file.srcUri = f.uri || ""; out.push(file); }
    catch (e) { alog("shared file failed: " + e.message); }
  }
  try { if (list.length) window.AndroidNative.clearShared(); } catch (e) {}
  return out;
}

/* ---------------------------------------------------------------- updates (always at the top) */
const updUI = { box: null, txt: null, btn: null, go: null, busy: false, latest: "" };
function showUpd(text, mode) {
  updUI.txt.textContent = text;
  updUI.box.classList.toggle("avail", mode === "avail");
  updUI.go.hidden = mode !== "avail";
}
/* The "Check for updates" button says what it's doing: "Checking for updates…", then "✓ Up to date" (or "Update
   available", "Couldn't check") for a couple of seconds, then fades back to "Check for updates". */
function updBtnFlash(text, ms) {
  const b = updUI.btn; if (!b) return;
  clearTimeout(updUI.flashT); b.disabled = false; b.textContent = text; b.style.transition = "opacity .35s"; b.style.opacity = "1";
  updUI.flashT = setTimeout(() => { b.style.opacity = "0"; updUI.flashT = setTimeout(() => { b.textContent = "Check for updates"; b.style.opacity = "1"; }, 350); }, ms || 2500);
}
async function checkUpdates(manual) {
  if (!NATIVE.kind) { if (manual) showUpd("Updates come through the Windows or Android app."); return; }
  if (updUI.busy) return;
  if (manual) showUpd("Checking for updates…");
  if (manual && updUI.btn) { clearTimeout(updUI.flashT); updUI.btn.style.opacity = "1"; updUI.btn.disabled = true; updUI.btn.textContent = "Checking for updates…"; }
  const r = (await NATIVE.checkUpdate()) || { ok: false, error: "network" };
  if (!r.ok) {
    if (manual) updBtnFlash("Couldn't check");
    if (manual) showUpd(r.error === "no-token" ? "Update checks aren't set up in this build." : /^http-(401|403|404)$/.test(r.error || "") ? "GitHub refused the update check. The app's update key may have expired." : "Couldn't check for updates. Check your connection.");
    else showUpd(CFG.name + " " + appVersion);
    return;
  }
  if (r.available) { if (manual) updBtnFlash("Update available");
    updUI.latest = r.latest; updUI.info = r.info || null; updUI.current = r.current;
    let skip = ""; try { skip = localStorage.getItem("updSkip") || ""; } catch (e) {}
    if (!manual && CFG.share && skip === r.latest) { showUpd(CFG.name + " " + r.current); return; }      // you chose to skip that one
    if (!manual && !updNotify()) { showUpd(CFG.name + " " + r.current); return; }                           // "Tell me when an update is available" is off
    showUpd(CFG.name + " " + r.latest + " is available (you have " + r.current + ").", "avail");
  }
  else { showUpd(manual ? "You're on the latest version (" + r.current + ")." : CFG.name + " " + r.current); if (manual) updBtnFlash("✓ Up to date"); }
}
/* The copy given to other people never updates without asking: Update first shows what's in the new version (the
   release page's notes, its date, size and SHA-256) over the page, and only "Agree and update" downloads it.
   "Not now" closes it; "Skip this version" also stops the start-up notice for that version (Check for updates still finds it). */
function updMd(md) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const inl = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(https:\/\/[^\s<)]+)/g, '<a href="$1" data-ext>$1</a>');
  let out = "", inList = false;
  for (const line of String(md).replace(/\r/g, "").split("\n")) {
    if (/^\s*- /.test(line)) { if (!inList) { out += "<ul>"; inList = true; } out += "<li>" + inl(line.replace(/^\s*- /, "")) + "</li>"; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (/^#{1,3} /.test(line)) out += "<h4>" + inl(line.replace(/^#+ /, "")) + "</h4>";
    else if (line.trim()) out += "<p>" + inl(line) + "</p>";
  }
  return out + (inList ? "</ul>" : "");
}
function updNotify() { try { return localStorage.getItem("updNotify") !== "0"; } catch (e) { return true; } }
function setUpdNotify(on) { try { localStorage.setItem("updNotify", on ? "1" : "0"); } catch (e) {} const c = document.getElementById("pUpdNotify"); if (c) c.checked = on; }
function askUpdate() {
  return new Promise((done) => {
    const i = updUI.info || {}, notes = String(i.notes || ""), cut = notes.indexOf("## Download"), what = (cut > 0 ? notes.slice(0, cut) : notes).replace(/<details>[\s\S]*?<\/details>/g, "").replace(/^Line-by-line differences:.*$/m, "");
    const o = document.createElement("div"); o.id = "updAsk";
    o.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px";
    const mb = i.size ? (i.size / 1048576).toFixed(0) + " MB" : "";
    o.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="updAskT" style="background:var(--card,#16181d);color:var(--text,#eee);border:1px solid var(--gold,#e3b341);border-radius:14px;max-width:760px;width:100%;max-height:88vh;display:flex;flex-direction:column">'
      + '<div style="padding:16px 18px 8px"><b id="updAskT" style="font-size:19px">Update to ' + CFG.name + " " + updUI.latest + "?</b>"
      + '<div class="small" style="opacity:.8;margin-top:4px">You have ' + (updUI.current || appVersion) + (i.date ? " · released " + new Date(i.date).toLocaleString() : "") + (mb ? " · " + mb + " to download" : "") + "</div></div>"
      + '<div style="overflow:auto;padding:0 18px;line-height:1.5">' + (what.trim() ? updMd(what) : "<p>The release page has no notes for this version.</p>")
      + '<h4>Details</h4><p class="small">' + (i.file ? "File: <code>" + i.file + "</code><br>" : "") + (i.sha256 ? "SHA-256: <code style=\"word-break:break-all\">" + i.sha256 + "</code><br>" : "") + "Built by GitHub from the public source code, with a build attestation and virus scans listed on the release page." + (i.page ? ' <a href="' + i.page + '" data-ext>Open the release page</a>' : "") + "</p>"
      + '<p class="small" style="opacity:.8">Nothing is downloaded unless you agree. Your settings and reports stay as they are. ' + CFG.name + " closes and reopens to finish.</p></div>"
      + '<label class="small" style="display:flex;gap:8px;align-items:center;padding:8px 18px 0;cursor:pointer"><input type="checkbox" id="updAskQuiet"' + (updNotify() ? "" : " checked") + '> Don\'t tell me when a new version is available (Check for updates still finds them; Settings turns it back on)</label>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--line,#333)"><button type="button" class="ghost small" data-a="skip">Skip this version</button><button type="button" class="ghost small" data-a="no">Not now</button><button type="button" class="small" data-a="yes">Agree and update</button></div></div>';
    const close = (v) => { const q = o.querySelector("#updAskQuiet"); if (q) setUpdNotify(!q.checked); document.removeEventListener("keydown", key, true); o.remove(); done(v); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); } };
    o.onclick = (e) => {
      const ext = e.target.closest("a[data-ext]"); if (ext) { e.preventDefault(); if (window.native && window.native.openUrl) window.native.openUrl(ext.getAttribute("href")); return; }
      const a = e.target.closest("button[data-a]"); if (!a) return;
      if (a.dataset.a === "skip") { try { localStorage.setItem("updSkip", updUI.latest); } catch (x) {} showUpd(CFG.name + " " + (updUI.current || appVersion) + " · skipped " + updUI.latest); return close(false); }
      if (a.dataset.a === "no") { showUpd(CFG.name + " " + updUI.latest + " is available (you have " + (updUI.current || appVersion) + ").", "avail"); return close(false); }
      close(true);
    };
    document.addEventListener("keydown", key, true);
    document.body.appendChild(o); o.querySelector('[data-a="no"]').focus();
  });
}
async function installUpdate() {
  if (CFG.share && !(await askUpdate())) return;
  updUI.busy = true; updUI.go.disabled = true; showUpd("Downloading the update…", "busy");
  const r = await NATIVE.installUpdate();
  updUI.busy = false; updUI.go.disabled = false;
  if (!r || !r.ok) { showUpd(r && r.error === "permission" ? "Allow " + CFG.name + " to install apps in the screen that opened, then tap Update again." : r && r.error === "not-portable" ? "Updates install by themselves only from " + CFG.name + ".exe." : "The update couldn't be downloaded. Try again later.", "avail"); return; }
  showUpd(NATIVE.kind === "e" ? "Installing. " + CFG.name + " will reopen in a moment." : "Opening the installer…");
  alog("installing update " + updUI.latest, true);
}
window.__updateProgress = (pct) => { if (updUI.busy) showUpd("Downloading the update… " + pct + "%", "busy"); };
async function initUpdates() {
  const sw = document.getElementById("pUpdNotify"); if (sw) { sw.checked = updNotify(); sw.onchange = () => { setUpdNotify(sw.checked); if (sw.checked) checkUpdates(false); }; }
  const box = $("upd");
  box.className = "upd";
  box.innerHTML = '<span class="t">…</span><button class="ghost small" type="button">Check for updates</button><button class="small" type="button" hidden>Update</button>';
  updUI.box = box; updUI.txt = box.children[0]; updUI.btn = box.children[1]; updUI.go = box.children[2];
  updUI.btn.onclick = () => checkUpdates(true);
  updUI.go.onclick = installUpdate;
  if (window.native && window.native.onUpdateProgress) window.native.onUpdateProgress(window.__updateProgress);
  appVersion = await NATIVE.version();
  showUpd(CFG.name + " " + appVersion);
  if (CFG.share && !CFG.updates) { updUI.btn.hidden = true; return; }          // a copy given to someone else with no public page to update from
  if (NATIVE.kind === "a") { updUI.btn.hidden = true; showUpd(CFG.name + " " + appVersion + " · pull down to check for updates"); pullToCheck(); }
  if (NATIVE.kind) setTimeout(() => checkUpdates(false), 1200);
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000) checkUpdates(false); });
}

/** Phones: pull down at the top of the page to check for updates (no button). */
function pullToCheck() {
  const tip = el("div", null, "Pull to check for updates");
  tip.style.cssText = "position:fixed;left:50%;top:0;transform:translate(-50%,-60px);background:#1e2127;border:1px solid #e3b341;color:#e3b341;font-size:13px;font-weight:600;padding:8px 14px;border-radius:999px;z-index:99;pointer-events:none;opacity:0;transition:none";
  document.body.appendChild(tip);
  const READY = 70; let y0 = null, d = 0;
  const put = (px) => { tip.style.transform = "translate(-50%," + (px - 60) + "px)"; tip.style.opacity = String(Math.min(1, px / 50)); };
  addEventListener("touchstart", (e) => {
    y0 = !updUI.busy && scrollY <= 0 && e.touches.length === 1 && !e.target.closest("#editor,.stage,.tl,.crop,input,select,textarea") ? e.touches[0].clientY : null; d = 0;
    tip.style.transition = "none";
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    d = e.touches[0].clientY - y0;
    if (d <= 0 || scrollY > 0) { put(0); return; }
    put(Math.min(d * 0.55, 110)); tip.textContent = d > READY ? "Release to check for updates" : "Pull to check for updates";
  }, { passive: true });
  addEventListener("touchend", () => {
    if (y0 === null) return;
    const go = d > READY && scrollY <= 0; y0 = null;
    tip.style.transition = "transform .25s, opacity .25s";
    if (!go) { put(0); return; }
    tip.textContent = "Checking for updates…"; put(70);
    checkUpdates(true).finally(() => setTimeout(() => put(0), 600));
  });
}

/* ---------------------------------------------------------------- server + sign-in */
const S = { server: store.get("server", CFG.server), token: store.get("token", ""), user: store.get("user", "") };
const deviceId = store.get("device", "") || (() => { const d = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("device", d); return d; })();
let onSignedIn = () => {}, onSignedOut = () => {};
class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }
async function api(path, opts) {
  opts = opts || {};
  const h = Object.assign({}, opts.headers || {});
  if (S.token) h.Authorization = "Bearer " + S.token;
  let body = opts.body;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== "string") { body = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  let r;
  try { r = await fetch(S.server.replace(/\/+$/, "") + path, { method: opts.method || (body ? "POST" : "GET"), headers: h, body, signal: opts.signal }); }
  catch (e) { if (e.name === "AbortError") throw e; throw new ApiError("Can't reach the server. Check your connection (and that the server is on).", 0); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== "/login") { signOut(true); throw new ApiError("Signed out. Sign in again.", 401); }
  if (!r.ok) throw new ApiError(j.error || ("The server answered " + r.status + "."), r.status, j);
  return j;
}
function signOut(expired) {
  if (!expired && S.token) api("/logout", { method: "POST" }).catch(() => {});
  S.token = ""; store.set("token", "");
  showSignIn(expired ? "You were signed out. Sign in again." : "");
  onSignedOut();
}
function showSignIn(msg) {
  const c = $("signin");
  c.hidden = false;
  c.innerHTML = `<div class="kv" style="margin-bottom:6px">Sign in to your sync server.</div>
    <label class="f" for="siUser">Username</label><input type="text" id="siUser" autocomplete="username" autocapitalize="off" spellcheck="false">
    <label class="f" for="siPass">Password</label><div class="row"><input type="password" id="siPass" autocomplete="current-password"><button class="ghost small" id="siShow" type="button">Show</button></div>
    <details class="opts" style="margin-top:8px"><summary>Server address</summary><input type="url" id="siServer" autocomplete="off" autocapitalize="off" spellcheck="false"></details>
    <button class="go" id="siGo" type="button">Sign in</button><div class="msg" id="siMsg"></div>`;
  $("siUser").value = S.user; $("siServer").value = S.server;
  $("siMsg").textContent = msg || "";
  $("siShow").onclick = () => { const p = $("siPass"); p.type = p.type === "password" ? "text" : "password"; $("siShow").textContent = p.type === "password" ? "Show" : "Hide"; };
  const go = async () => {
    const user = $("siUser").value.trim(), pass = $("siPass").value;
    S.server = ($("siServer").value.trim() || CFG.server).replace(/\/+$/, ""); store.set("server", S.server);
    if (!user || !pass) { $("siMsg").textContent = "Enter your username and password."; return; }
    $("siGo").disabled = true; $("siMsg").className = "msg"; $("siMsg").textContent = "Signing in…";
    try {
      const r = await api("/login", { body: { user, pass, device: deviceId, deviceName: NATIVE.kind === "a" ? "Android phone" : NATIVE.kind === "e" ? "Windows PC" : "browser" } });
      S.token = r.token; S.user = r.user; store.set("token", S.token); store.set("user", S.user);
      alog("signed in as " + r.user);
      c.hidden = true; onSignedIn();
    } catch (e) { $("siMsg").className = "msg bad"; $("siMsg").textContent = e.message; }
    finally { $("siGo") && ($("siGo").disabled = false); }
  };
  $("siGo").onclick = go;
  $("siPass").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

/* ---------------------------------------------------------------- uploads (in parts) and jobs */
async function uploadFile(file, onPct, signal) {
  const start = await api("/uploads", { body: { name: file.name, size: file.size }, signal });
  const id = start.id, chunk = Math.min(start.chunk || 24 * 1048576, 24 * 1048576);
  let at = 0, fails = 0;
  while (at < file.size) {
    if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
    try {
      const r = await api("/uploads/" + id + "?at=" + at, { method: "PUT", body: file.slice(at, at + chunk), headers: { "Content-Type": "application/octet-stream" }, signal });
      at = r.got; fails = 0;
      if (onPct) onPct((at / file.size) * 100);
    } catch (e) {
      if (e.name === "AbortError" || e.status === 404 || e.status === 401) throw e;
      if (e.status === 409 && e.body && e.body.got != null) { at = e.body.got; continue; }
      if (++fails > 5) throw e;
      await sleep(1500 * fails);
      try { at = (await api("/uploads/" + id, { signal })).got; } catch (x) {}
    }
  }
  return id;
}
async function waitJob(id, onUpdate, signal) {
  let fails = 0;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
    let j;
    try { j = (await api("/jobs/" + id, { signal })).job; fails = 0; }
    catch (e) { if (e.name === "AbortError" || e.status === 404 || e.status === 401 || ++fails > 20) throw e; await sleep(2000); continue; }
    if (onUpdate) onUpdate(j);
    if (j.status === "done") return j;
    if (j.status === "error") throw new ApiError(j.error || "It failed.", 500);
    if (j.status === "cancelled" || j.status === "gone") throw new DOMException("Cancelled", "AbortError");
    await sleep(j.status === "queued" ? 1200 : 700);
  }
}
/** A link to a finished file that works without the sign-in token (for the app's downloader and <video>/<img>). */
async function fileLink(jobId, inline) {
  const t = (await api("/jobs/" + jobId + "/ticket", { method: "POST" })).ticket;
  return S.server.replace(/\/+$/, "") + "/jobs/" + jobId + "/file?ticket=" + t + (inline ? "&inline=1" : "");
}

/* ---------------------------------------------------------------- start-up */
function boot(signedIn, signedOut) {
  onSignedIn = signedIn; onSignedOut = signedOut || (() => {});
  initUpdates();
  // dropping a file anywhere must never open it in place of the app
  ["dragover", "drop"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
  if (S.token) onSignedIn(); else showSignIn();
  alog("opened" + (NATIVE.kind === "a" ? " on Android" : NATIVE.kind === "e" ? " on Windows" : ""));
}
