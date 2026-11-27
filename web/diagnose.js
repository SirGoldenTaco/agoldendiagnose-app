/* aGoldenDiagnose: the page. Games being watched, the reports, and reading one report.
 * The watching and collecting happen in the app itself (desktop/watch.js + the helper); analyze.js reads a report. */
"use strict";
const D = window.Diagnose, N = (window.native && window.native.diag) || null;
const plain = (e) => String((e && e.message) || e || "Something went wrong.").replace(/^Error:\s*/, "");
let toastTimer = 0;
function toast(text, bad, ms) { const t = $("toast"); t.textContent = text; t.className = bad ? "bad" : ""; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms || 3500); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(plain(e), true, 6000); alog("error: " + plain(e)); } };
const when = (ms) => { const d = new Date(ms), now = new Date(), same = d.toDateString() === now.toDateString(), y = new Date(now - 864e5).toDateString() === d.toDateString(); return (same ? "Today" : y ? "Yesterday" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
const KIND = { crash: "Crash", gpu: "Graphics", vram: "Video memory", oom: "Out of memory", hang: "Froze", error: "Error exit", start: "Won't start", pc: "PC crash", normal: "Normal", unknown: "Unknown" };
const badge = (k) => { const b = el("span", "badge k-" + k, KIND[k] || k); return b; };
const btn = (cls, text, fn, title) => { const b = el("button", cls, text); b.type = "button"; if (title) b.title = title; b.onclick = guard(fn); return b; };

let ST = { ok: false, helper: false, games: [], reports: [], settings: {}, ignore: [] };
let repFilter = "", repQuery = "", repOpen = false, OPEN = null;           // OPEN: the report being read

/* ---------------------------------------------------------------- Games */
async function refresh() {
  if (!N) { $("bannerText").textContent = "aGoldenDiagnose watches games in its Windows app. This page alone can't."; $("banner").className = "banner bad"; return; }
  ST = await N.state();
  drawGames(); drawReports(); drawSettings();
}
function drawGames() {
  const running = ST.games.filter((g) => g.running), bn = $("banner");
  bn.className = "banner" + (ST.helper ? "" : " bad");
  $("bannerText").textContent = !ST.ok ? "Watching games only works on Windows." : !ST.helper ? "The watcher isn't running. It restarts by itself in a few seconds; if this stays, restart aGoldenDiagnose."
    : running.length ? "Watching " + running.map((g) => g.name).join(", ") : ST.settings.auto ? "Ready. Start a game and it is picked up by itself." : "Ready. Watching the games listed below when they start.";
  const box = $("games"); box.textContent = "";
  $("gamesMsg").hidden = ST.games.length > 0;
  for (const g of ST.games) {
    const c = el("div", "g" + (g.running ? " run" : "")); c.dataset.key = g.key;
    const top = el("div", "top"); top.appendChild(el("span", "nm", g.name)); top.appendChild(el("span", "exe", g.exe));
    top.appendChild(el("span", "grow"));
    if (g.last) { const b = badge(g.last.kind); b.title = g.last.title + " · " + when(g.last.end); top.appendChild(b); }
    c.appendChild(top);
    const sub = el("div", "kv"); sub.textContent = g.running ? "Playing now · started " + ago(g.running.since) + (g.running.title && g.running.title !== g.name ? " · " + g.running.title : "") : !g.watch ? "Not watched" : g.lastSeen ? "Not running · last seen " + ago(g.lastSeen) : "Not running · waiting for it to start";
    c.appendChild(sub);
    if (g.running) { const lv = el("div", "live"); lv.id = "live-" + g.running.pid; c.appendChild(lv); paintLive(lv, g.running); }
    const acts = el("div", "acts");
    if (g.reports) acts.appendChild(btn("", g.reports + " report" + (g.reports > 1 ? "s" : ""), () => { repFilter = g.key; show("rep"); closeReport(); drawReports(); }));
    else acts.appendChild(el("span", "kv", "No reports"));
    acts.appendChild(el("span", "grow"));
    const dump = btn("ghost small", "Crash dumps…", async () => {
      const cur = await N.dumps(g.exe, null), on = !!(cur && cur.on);
      if (!confirm(on ? "Windows is saving a small crash dump whenever " + g.name + " crashes.\n\nTurn that off?" : "Have Windows save a small crash dump whenever " + g.name + " crashes?\n\nThe dump shows exactly which file the crash happened in, and it is added to the report. Windows will ask for administrator rights once.")) return;
      const r = await N.dumps(g.exe, !on); if (!r || !r.ok) throw new Error((r && r.error) || "Windows didn't allow the change."); toast(on ? "Crash dumps are off for " + g.name + "." : "Windows will now save a crash dump when " + g.name + " crashes.", false, 5000);
    }, "A Windows feature (WER LocalDumps), per game");
    if (!/Linux/.test(navigator.userAgent) || /Android/i.test(navigator.userAgent)) acts.appendChild(dump);
    acts.appendChild(btn("ghost small", "Rename", async () => { const n = prompt("Name shown for this game:", g.name); if (n && n.trim()) { await N.game({ key: g.key, name: n }); refresh(); } }));
    acts.appendChild(btn("ghost small", g.watch ? "Stop watching" : "Watch", async () => { await N.game({ key: g.key, watch: !g.watch }); refresh(); }));
    acts.appendChild(btn("ghost small", "Remove", async () => { await N.game({ key: g.key, remove: true }); toast(g.name + " moved to Hidden. It isn't watched any more."); refresh(); }));
    c.appendChild(acts); box.appendChild(c);
  }
  $("ignoredCard").hidden = !ST.ignore.length; const ig = $("ignored"); ig.textContent = "";
  const igOpen = store.get("hiddenOpen", false) === true; $("ignoredBody").hidden = !igOpen; $("ignoredHead").setAttribute("aria-expanded", String(igOpen)); $("ignoredArrow").style.transform = igOpen ? "rotate(90deg)" : ""; $("ignoredTitle").textContent = "Hidden (" + ST.ignore.length + ")";
  $("ignoredHead").onclick = () => { store.set("hiddenOpen", !igOpen); drawGames(); };
  for (const k of ST.ignore) { const r = el("div", "frow"); r.appendChild(el("div", "t", k)); r.appendChild(btn("ghost small", "Watch again", async () => { await N.unignore(k); refresh(); })); ig.appendChild(r); }
}
function paintLive(box, s) {
  box.textContent = "";
  const p = (label, val, hot) => { const x = el("span", "pill" + (hot ? " hot" : "")); x.appendChild(document.createTextNode(label + " ")); x.appendChild(el("b", null, val)); box.appendChild(x); };
  if (s.hung > 3000) p("Not responding", D.fmtDur(s.hung), true);
  if (s.cpu >= 0) p("CPU", Math.round(s.cpu) + "%");
  if (s.pm > 0) p("Memory", D.fmtMB(s.pm));
  if (s.gpu >= 0) p("GPU", Math.round(s.gpu) + "%");
  if (s.vram > 0) p("Video memory", D.fmtMB(s.vram));
  if (s.gt > 0) p("Card", Math.round(s.gt) + " °C", s.gt >= 87);
}
async function pick() {
  $("picker").hidden = false; const box = $("pickList"); box.textContent = ""; box.appendChild(el("div", "empty", "Looking…"));
  const hid = new Set(ST.ignore || []), list = (await N.procs()).filter((p) => !p.watched && !hid.has(String(p.name).toLowerCase())).sort((a, b) => (b.game - a.game) || a.name.localeCompare(b.name));
  box.textContent = ""; if (!list.length) box.appendChild(el("div", "empty", "No other program with a window is open. Start the game first, or add its .exe."));
  for (const p of list) { const r = el("div", "frow"), t = el("div", "t", (p.title || p.name).slice(0, 80)); t.appendChild(el("small", null, p.name + " · " + p.path)); r.appendChild(t); if (p.game) r.appendChild(el("span", "badge k-normal", "Game")); r.appendChild(btn("ghost small", "Hide", async () => { await N.hide(p.name); await refresh(); r.remove(); toast(p.name + " is in Hidden now (Games tab, at the bottom)."); if (!box.children.length) box.appendChild(el("div", "empty", "Nothing left to show.")); })); r.appendChild(btn("", "Watch", async () => { const x = await N.add({ pid: p.pid }); if (!x.ok) throw new Error(x.error || "That program couldn't be watched."); $("picker").hidden = true; toast("Watching " + p.name + "."); refresh(); })); box.appendChild(r); }
}

/* ---------------------------------------------------------------- Reports: the list */
/* Which game's reports to show: a drop-down with a search box. It stays one tidy line however many games there are
 * (a row of one button per game ran off the screen once there were more than a handful). */
function buildFilter(games, counts) {
  const nameOf = new Map(games), wrap = el("div", "dd" + (repOpen ? " open" : ""));
  const head = el("button", "ddhead"); head.type = "button"; head.title = "Choose a game";
  head.appendChild(el("span", "ddname", repFilter ? nameOf.get(repFilter) : "All games"));
  head.appendChild(el("span", "ddnum", String(repFilter ? counts[repFilter] : ST.reports.length)));
  head.appendChild(el("span", "ddcaret", "▾"));
  head.onclick = (e) => { e.stopPropagation(); repOpen = !repOpen; if (!repOpen) repQuery = ""; drawReports(); };
  wrap.appendChild(head);
  if (!repOpen) return wrap;
  const panel = el("div", "ddpanel"), search = el("input", "ddsearch"), listBox = el("div", "ddlist");
  search.type = "text"; search.placeholder = "Search games…"; search.value = repQuery; search.spellcheck = false; search.autocomplete = "off";
  const matching = () => { const q = repQuery.trim().toLowerCase(); return games.filter(([, n]) => !q || String(n).toLowerCase().includes(q)); };
  const pick = (key) => { repFilter = key; repOpen = false; repQuery = ""; drawReports(); };
  const fill = () => {
    listBox.textContent = "";
    const opts = (repQuery.trim() ? [] : [["", "All games", ST.reports.length]]).concat(matching().map(([k, n]) => [k, n, counts[k]]));
    if (!opts.length) { listBox.appendChild(el("div", "ddnone", "No game matches “" + repQuery.trim() + "”.")); return; }
    for (const [k, n, c] of opts) {
      const o = el("button", "ddopt" + (k === repFilter ? " on" : "")); o.type = "button";
      o.appendChild(el("span", "n", n)); o.appendChild(el("span", "c", String(c)));
      o.onclick = (e) => { e.stopPropagation(); pick(k); };
      listBox.appendChild(o);
    }
  };
  search.oninput = () => { repQuery = search.value; fill(); };
  search.onclick = (e) => e.stopPropagation();
  search.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); repOpen = false; repQuery = ""; drawReports(); }
    else if (e.key === "Enter") { e.preventDefault(); const m = matching(); pick(repQuery.trim() ? (m[0] ? m[0][0] : repFilter) : ""); }      // Enter: the first match
  };
  panel.appendChild(search); panel.appendChild(listBox); wrap.appendChild(panel); fill();
  setTimeout(() => { try { search.focus(); } catch (e) {} }, 0);
  return wrap;
}
function drawReports() {
  const f = $("repFilter"); f.textContent = "";
  const games = [...new Map(ST.reports.map((r) => [r.key, r.game])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const counts = {}; for (const r of ST.reports) counts[r.key] = (counts[r.key] || 0) + 1;
  if (repFilter && !games.some(([k]) => k === repFilter)) repFilter = "";
  if (games.length > 1) f.appendChild(buildFilter(games, counts)); else { repFilter = ""; repOpen = false; repQuery = ""; }
  const list = ST.reports.filter((r) => !repFilter || r.key === repFilter), box = $("reports"); box.textContent = "";
  $("repMsg").hidden = list.length > 0;
  // what the reports say together
  // Patterns: a card that folds away; each one can be dismissed into an archive (and brought back from it)
  const pats = D.patterns(ST.reports).filter((p) => !repFilter || !p.game || p.game === repFilter);
  const arch = store.get("patArchive", {}) || {};
  const shownP = pats.filter((p) => !arch[p.key]);
  for (const p of pats) if (arch[p.key]) Object.assign(arch[p.key], { title: p.title, text: p.text, sev: p.sev });          // kept up to date in the archive
  const archived = Object.entries(arch).sort((a, b) => b[1].at - a[1].at);
  if (shownP.length || archived.length) {
    const c = el("details", "card pats"); c.style.marginBottom = "10px"; c.open = store.get("patOpen", true) !== false;
    c.addEventListener("toggle", () => store.set("patOpen", c.open));
    const sm = el("summary"); sm.style.cssText = "cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px";
    const h = el("div", "sec", "Patterns" + (shownP.length ? " (" + shownP.length + ")" : "")); h.style.margin = "0"; sm.appendChild(h); sm.appendChild(el("span", "grow")); sm.appendChild(el("small", "kv", c.open ? "▾" : "▸"));
    c.addEventListener("toggle", () => { sm.lastChild.textContent = c.open ? "▾" : "▸"; });
    c.appendChild(sm);
    if (!shownP.length) { const e = el("div", "kv", "Nothing new. Dismissed ones are in the archive below."); e.style.marginTop = "8px"; c.appendChild(e); }
    for (const p of shownP) {
      const d = el("div", "find s-" + p.sev); d.style.position = "relative"; d.style.paddingRight = "34px";
      d.appendChild(el("b", null, p.title)); d.appendChild(el("span", null, p.text));
      const x = btn("ghost small", "✕", () => { const a = store.get("patArchive", {}) || {}; a[p.key] = { at: Date.now(), title: p.title, text: p.text, sev: p.sev }; store.set("patArchive", a); drawReports(); });
      x.title = "Dismiss (it goes to the archive)"; x.style.cssText = "position:absolute;top:6px;right:6px;padding:2px 8px"; d.appendChild(x);
      c.appendChild(d);
    }
    if (archived.length) {
      const ad = el("details"); ad.style.marginTop = "8px"; const as = el("summary", "kv", "Archive (" + archived.length + ")"); as.style.cursor = "pointer"; ad.appendChild(as);
      for (const [k, v] of archived) {
        const d = el("div", "find s-" + (v.sev || "warn")); d.style.opacity = ".7"; d.style.position = "relative"; d.style.paddingRight = "90px";
        d.appendChild(el("b", null, v.title)); d.appendChild(el("span", null, (v.text || "") + " (dismissed " + when(v.at) + ")"));
        const back = btn("ghost small", "Bring back", () => { const a = store.get("patArchive", {}) || {}; delete a[k]; store.set("patArchive", a); drawReports(); });
        back.style.cssText = "position:absolute;top:6px;right:6px;padding:2px 8px"; d.appendChild(back); ad.appendChild(d);
      }
      const clr = btn("ghost small", "Empty the archive", () => { store.set("patArchive", {}); drawReports(); }); clr.style.marginTop = "6px"; ad.appendChild(clr);
      c.appendChild(ad);
    }
    box.appendChild(c);
  }
  // Reports: each can be archived (✕), and old ones all at once; archived ones wait at the bottom and can come back.
  // Archiving only hides a report from the list: its folder and files stay, and Patterns still count it.
  const rarch = store.get("repArchive", {}) || {}, ids = new Set(ST.reports.map((r) => r.id));
  for (const k of Object.keys(rarch)) if (!ids.has(k)) delete rarch[k];          // reports deleted since: forgotten
  const setArch = (fn) => { const a = Object.assign({}, store.get("repArchive", {}) || {}); fn(a); store.set("repArchive", a); drawReports(); };
  const live = list.filter((r) => !rarch[r.id]), gone = list.filter((r) => rarch[r.id]).sort((a, b) => rarch[b.id] - rarch[a.id]);
  const OLD = 30 * 86400000, old = live.filter((r) => Date.now() - r.end > OLD);
  const row = (r, archived) => {
    const w = el("div"); w.style.position = "relative";
    const b = el("button", "rrow"); b.type = "button"; b.appendChild(badge(r.kind)); b.style.paddingRight = archived ? "104px" : "44px"; if (archived) b.style.opacity = ".7";
    const t = el("div", "t"); t.appendChild(el("b", null, r.game + " · " + r.title)); t.appendChild(el("small", null, when(r.end) + " · played " + D.fmtDur(r.end - r.start) + (r.files ? " · " + r.files + " file" + (r.files > 1 ? "s" : "") + " collected" : "") + (archived ? " · archived " + when(rarch[r.id]) : "")));
    b.appendChild(t); b.onclick = guard(() => openReport(r.id)); w.appendChild(b);
    const x = archived ? btn("ghost small", "Bring back", () => setArch((a) => { delete a[r.id]; })) : btn("ghost small", "✕", () => setArch((a) => { a[r.id] = Date.now(); }));
    x.title = archived ? "Put it back in the list" : "Archive (it moves to the bottom; nothing is deleted)";
    x.style.cssText = "position:absolute;top:50%;right:8px;transform:translateY(-50%);padding:2px 8px"; w.appendChild(x);
    return w;
  };
  if (old.length) {
    const bar = el("div", "row"); bar.style.cssText = "margin:0 0 8px;gap:8px;align-items:center";
    bar.appendChild(el("span", "kv grow", old.length + " report" + (old.length > 1 ? "s are" : " is") + " older than 30 days."));
    bar.appendChild(btn("ghost small", "Archive them", () => setArch((a) => { const now = Date.now(); for (const r of old) a[r.id] = now; })));
    box.appendChild(bar);
  }
  if (!live.length && gone.length) { const e = el("div", "empty", "Every report is in the archive below."); box.appendChild(e); }
  for (const r of live) box.appendChild(row(r, false));
  if (gone.length) {
    const ad = el("details", "card"); ad.style.marginTop = "10px"; ad.open = store.get("repArchOpen", false) === true;
    ad.addEventListener("toggle", () => store.set("repArchOpen", ad.open));
    const as = el("summary", "kv", "Archived reports (" + gone.length + ")"); as.style.cursor = "pointer"; ad.appendChild(as);
    const note = el("div", "kv", "Hidden from the list, nothing deleted: open one, or bring it back."); note.style.margin = "6px 0"; ad.appendChild(note);
    for (const r of gone) ad.appendChild(row(r, true));
    const all = btn("ghost small", "Bring them all back", () => setArch((a) => { for (const r of gone) delete a[r.id]; })); all.style.marginTop = "6px"; ad.appendChild(all);
    box.appendChild(ad);
  }
}

/* ---------------------------------------------------------------- Reports: reading one */
function closeReport() { OPEN = null; $("repView").hidden = true; $("repList").hidden = false; }
async function openReport(id) {
  const x = await N.report(id); if (!x.ok) throw new Error(x.error);
  OPEN = { id, r: x.report, tl: x.timeline, tail: x.tail, a: D.analyze(x.report), sub: "lines", range: "all", off: new Set(store.get("chartOff", ["pcCpu"])) };
  show("rep"); $("repList").hidden = true; $("repView").hidden = false; drawReport(); window.scrollTo(0, 0);
}
function drawReport() {
  const { r, a, id } = OPEN, v = $("repView"); v.textContent = "";
  const head = el("div", "row"); head.style.marginBottom = "10px"; { const bk = btn("ghost", "← Back", () => closeReport()); bk.setAttribute("data-back", ""); head.appendChild(bk); }
  head.appendChild(el("b", null, r.game.name + (r.game.version ? " " + r.game.version : ""))); head.lastChild.style.fontSize = "17px"; head.appendChild(el("span", "kv", when(r.end))); v.appendChild(head);
  const bad = ["crash", "gpu", "pc"].includes(a.kind), ver = el("div", "verdict" + (bad ? " is-bad" : a.kind === "normal" ? " is-ok" : ""));
  const h = el("h3", null, a.title); ver.appendChild(h); ver.appendChild(el("p", null, a.why));
  const facts = el("div", "facts"); for (const [k, val] of a.facts) { const f = el("div", "fact"); f.appendChild(el("small", null, k)); f.appendChild(el("b", null, val)); facts.appendChild(f); } ver.appendChild(facts);
  const acts = el("div", "row"); acts.style.marginTop = "12px";
  acts.appendChild(btn("", "Export as a .zip", async () => { toast("Packing the report…", false, 60000); const x = await N.exportZip(id); if (x && x.cancelled) { toast("", false, 1); return; } if (!x.ok) throw new Error(x.error || "The .zip couldn't be made."); toast("Saved in " + (/Linux/.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) ? "Downloads/aGoldenDiagnose" : "Downloads\\aGoldenDiagnose") + " (" + fmtSize(x.size) + ")" + (x.hidden ? ", with your user name and PC name hidden" : "") + ".", false, 6000); }, "Everything in one file, to send to the game's support or a friend"));
  acts.appendChild(btn("ghost", "Copy the summary", async () => { await window.native.copyText(D.summaryText(r, a)); toast("Summary copied. Paste it anywhere."); }));
  acts.appendChild(btn("ghost", "Open the folder", () => N.folder(id)));
  // for asking for help on Discord: short, with the error lines in a code block; your user and PC names are hidden
  acts.appendChild(btn("ghost", "Copy for Discord", async () => { const t = await N.tools("hide", { text: D.discordText(r, a) }); await window.native.copyText((t && t.text) || ""); toast("Copied for Discord (your user and PC names are hidden). Paste it in a message."); }));
  if (r.game && r.game.steam) acts.appendChild(btn("ghost", "Verify the game's files", async () => { const x = await N.tools("verify", { id }); if (!x || !x.ok) throw new Error((x && x.error) || "Steam couldn't be asked."); toast("Steam is checking " + r.game.name + "'s files and replaces any that are damaged or missing."); }));
  acts.appendChild(btn("ghost", "Clear shader caches…", async () => {
    const x = await N.tools("shaders", { id }); const dirs = (x && x.dirs) || [];
    if (!dirs.length) { toast("The shader caches are already empty."); return; }
    const mb = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1048576)) + " MB";
    if (!confirm("Clear the shader caches?\n\n" + dirs.map((d) => "• " + d.name + ": " + mb(d.bytes)).join("\n") +
      "\n\nThey're rebuilt by themselves: the first minutes of each game may stutter a little while that happens. It often fixes crashes and stutters that started after a driver or game update. Close your games first (files they're using are left alone).")) return;
    const c = await N.tools("shaders-clear", { id }); if (!c || !c.ok) throw new Error("The caches couldn't be cleared.");
    toast("Cleared " + mb(c.freed) + (c.kept ? " (" + c.kept + " files in use were left)" : "") + ".");
  }));
  if (store.get("aiLocal", false)) acts.appendChild(btn("ghost", "✨ Explain (local AI)", () => explain()));
  else if (hasClaude()) acts.appendChild(btn("ghost", "✨ Explain with Claude", () => explain()));
  acts.appendChild(el("span", "grow"));
  acts.appendChild(btn("ghost small", "Delete", async () => { if (!confirm("Delete this report and the files collected with it?\n\nThis can't be undone.")) return; await N.del(id); closeReport(); refresh(); }));
  ver.appendChild(acts); v.appendChild(ver);
  const ai = el("div", "card"); ai.id = "aiCard"; ai.hidden = true; ai.style.marginTop = "10px"; ai.appendChild(el("div", "sec", "Claude's reading")); ai.firstChild.style.marginTop = "0"; const aiText = el("div"); aiText.id = "ai"; ai.appendChild(aiText); v.appendChild(ai);
  const kept = store.get("ai:" + id, ""); if (kept) { ai.hidden = false; aiText.textContent = kept; }
  v.appendChild(fixesCard(r, a, id));
  if (a.tips.length) { const c = el("div", "card"); c.style.marginTop = "10px"; c.appendChild(el("div", "sec", "Things to try, in this order")); c.firstChild.style.marginTop = "0"; const ul = el("ol", "tips"); for (const t of a.tips) ul.appendChild(el("li", null, t)); c.appendChild(ul); v.appendChild(c); }
  if (a.findings.length) { const c = el("div", "card"); c.style.marginTop = "10px"; c.appendChild(el("div", "sec", "Also noticed")); c.firstChild.style.marginTop = "0"; for (const f of a.findings) { const d = el("div", "find s-" + f.sev); d.appendChild(el("b", null, f.title)); d.appendChild(el("span", null, f.text)); c.appendChild(d); } v.appendChild(c); }
  // what the game was using
  if (OPEN.tl.length > 2) {
    const c = el("div", "card"); c.style.marginTop = "10px"; const hd = el("div", "row"); hd.appendChild(el("div", "sec", "What it was using")); hd.firstChild.style.margin = "0"; hd.appendChild(el("span", "grow"));
    const rg = el("div", "chips"); for (const [k, label] of [["all", "Whole session"], ["tail", "Last 5 minutes"]]) { const b = el("button", OPEN.range === k ? "on" : "", label); b.type = "button"; b.onclick = () => { OPEN.range = k; drawReport(); }; rg.appendChild(b); } hd.appendChild(rg); c.appendChild(hd);
    const lg = el("div", "legend"); lg.id = "legend"; c.appendChild(lg); const cv = el("canvas"); cv.id = "chart"; c.appendChild(cv); v.appendChild(c);
    requestAnimationFrame(drawChart);
  }
  // the details
  const sub = el("div", "sub"), counts = { lines: (r.logHits || []).length, files: (r.files || []).filter((f) => f.name).length, events: (r.events || []).length };
  for (const [k, label] of [["lines", "Log lines that matter (" + counts.lines + ")"], ["files", "Files collected (" + counts.files + ")"], ["events", "Windows events (" + counts.events + ")"], ["pc", "This PC"]]) { const b = el("button", OPEN.sub === k ? "" : "ghost", label); b.type = "button"; b.onclick = () => { OPEN.sub = k; drawReport(); }; sub.appendChild(b); }
  v.appendChild(sub);
  const body = el("div", "card"); v.appendChild(body);
  if (OPEN.sub === "lines") {
    if (!counts.lines) body.appendChild(el("div", "empty", counts.files ? "None of the collected logs has a line that looks like an error. Open them under “Files collected”." : "No log file from the game was found for this session."));
    let last = ""; for (const hh of r.logHits || []) { if (hh.file !== last) { last = hh.file; const t = el("div", "sec", hh.file); if (body.children.length === 0) t.style.marginTop = "0"; body.appendChild(t); } const d = el("div", "hit"); d.appendChild(el("small", null, (D.TAG_NAME[hh.tag] || hh.tag) + " · line " + hh.n + "\n")); d.appendChild(document.createTextNode(hh.text)); d.title = "Open the file at this line"; d.onclick = guard(() => viewFile(hh.file, hh.n)); body.appendChild(d); }
  } else if (OPEN.sub === "files") {
    if (!(r.files || []).length) body.appendChild(el("div", "empty", "No log or dump written during this session was found."));
    for (const f of r.files || []) { const row = el("div", "frow"), t = el("div", "t", f.name || f.orig.replace(/^.*\\/, "")); t.appendChild(el("small", null, (f.skipped ? f.skipped + " · " : fmtSize(f.size) + (f.cut ? " (middle left out)" : "") + (f.hits ? " · " + f.hits + " error line" + (f.hits > 1 ? "s" : "") : "") + " · ") + f.orig)); t.lastChild.title = f.orig; row.appendChild(t);
      row.appendChild(el("span", "badge", { "game-log": "Game log", "game-dump": "Crash dump", dump: "Crash dump", wer: "Windows report", log: "Log" }[f.kind] || f.kind));
      if (f.name && !/\.(dmp|mdmp|hdmp)$/i.test(f.name)) row.appendChild(btn("ghost small", "Read", () => viewFile(f.name, 0)));
      body.appendChild(row); }
    for (const d of r.dumps || []) if (d.hasException) { const x = el("div", "find s-bad"); x.appendChild(el("b", null, "Crash dump " + d.name)); x.appendChild(el("span", null, d.codeHex + (D.codeInfo(d.code) ? " · " + D.codeInfo(d.code)[0] : "") + " inside " + (d.module || "an unknown file") + " at " + d.offset)); body.appendChild(x); }
  } else if (OPEN.sub === "events") {
    if (!counts.events) body.appendChild(el("div", "empty", "Windows wrote nothing relevant in its event log during this session."));
    for (const e of (r.events || []).slice().reverse()) { const d = el("details", "ev l" + e.level), s = el("summary"); s.textContent = new Date(e.t).toLocaleTimeString() + " · " + e.provider + " " + e.id + " · " + String(e.message || (e.data || []).join(" ")).replace(/\s+/g, " ").slice(0, 110); d.appendChild(s); d.appendChild(el("pre", null, (e.message || "") + (e.data && e.data.length ? "\n\n" + e.data.join("\n") : ""))); body.appendChild(d); }
  } else {
    const s = r.system || {}, tb = el("table", "kv2"), row = (k, val) => { if (!val) return; const tr = el("tr"); tr.appendChild(el("td", null, k)); tr.appendChild(el("td", null, val)); tb.appendChild(tr); };
    row("Processor", s.cpu ? s.cpu + " (" + s.threads + " threads)" : ""); row("Memory", s.ramMB ? D.fmtMB(s.ramMB) + " · page file " + D.fmtMB(Math.max(0, s.pagefileMB || 0)) : "");
    for (const g of s.gpus || []) row("Graphics card", g.name + (g.vramMB ? " · " + D.fmtMB(g.vramMB) : "") + " · driver " + g.driver + (g.driverDate ? " (" + g.driverDate + ")" : ""));
    row("Windows", [s.os, s.osVersion, s.osBuild ? "build " + s.osBuild : ""].filter(Boolean).join(" ")); row("Screen", s.screen); row("Motherboard", [s.board, s.bios ? "BIOS " + s.bios : ""].filter(Boolean).join(" · "));
    row("Drives", (s.disks || []).map((d) => d.name + " " + d.freeGB + " GB free of " + d.totalGB).join(" · ")); row("PC had been on for", s.uptimeMin ? D.fmtDur(s.uptimeMin * 60000) : "");
    row("Game program", r.game.path); row("Game version", [r.game.version, r.game.company].filter(Boolean).join(" · "));
    row("Also running", (r.others || []).join(", ")); row("Files loaded in the game", r.modules && r.modules.length ? r.modules.length + ": " + r.modules.filter((m) => { const k = D.moduleKind(m, r.game.exe, "", ""); return k && !["windows", "other", "game", "dx", "gpu"].includes(k.kind); }).slice(0, 30).join(", ") : "");
    body.appendChild(tb);
  }
}
const SERIES = [["cpu", "Game CPU", "#e3b341", 1, (r) => 100, "%"], ["ram", "Game memory", "#58a6ff", 2, (r) => (r.system && r.system.ramMB) || 0, "MB"], ["gpu", "Game GPU", "#56d364", 3, () => 100, "%"], ["vram", "Game video memory", "#bc8cff", 4, (r) => { const g = ((r.system && r.system.gpus) || []).map((x) => x.vramMB || 0); return Math.max(0, ...g); }, "MB"], ["temp", "Card temperature", "#ff7b72", 8, () => 100, "°C"], ["pcCpu", "Whole PC CPU", "#8b949e", 5, () => 100, "%"]];
function drawChart() {
  const cv = $("chart"); if (!cv || !OPEN) return;
  const rows = OPEN.range === "tail" ? OPEN.tail : OPEN.tl, r = OPEN.r, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const padL = 36, padB = 20, padT = 8, pw = W - padL - 8, ph = H - padT - padB, t0 = rows[0][0], t1 = rows[rows.length - 1][0], X = (t) => padL + (t1 > t0 ? ((t - t0) / (t1 - t0)) * pw : 0), Y = (p) => padT + ph - (Math.max(0, Math.min(100, p)) / 100) * ph;
  g.strokeStyle = "rgba(255,255,255,.08)"; g.fillStyle = "rgba(255,255,255,.45)"; g.font = "11px system-ui"; g.lineWidth = 1;
  for (const p of [0, 25, 50, 75, 100]) { g.beginPath(); g.moveTo(padL, Y(p)); g.lineTo(W - 8, Y(p)); g.stroke(); g.fillText(p + "%", 4, Y(p) + 4); }
  const span = t1 - t0; for (let i = 0; i <= 4; i++) { const t = t0 + (span * i) / 4, label = "-" + D.fmtDur(t1 - t).replace(/ \d+ s$/, ""); g.fillText(i === 4 ? "end" : label, Math.min(W - 40, X(t) - 10), H - 5); }
  // not responding: red bands
  g.fillStyle = "rgba(255,123,114,.22)"; let from = null; for (const row of rows) { if (row[9] > 0 && from === null) from = row[0]; if ((row[9] === 0 || row === rows[rows.length - 1]) && from !== null) { g.fillRect(X(from), padT, Math.max(2, X(row[0]) - X(from)), ph); from = null; } }
  const lg = $("legend"); lg.textContent = "";
  for (const [key, label, color, idx, maxOf, unit] of SERIES) {
    const max = maxOf(r), last = rows[rows.length - 1][idx], has = rows.some((x) => x[idx] > 0);
    if (!has || (unit === "MB" && !max)) continue;
    const b = el("button", "ghost" + (OPEN.off.has(key) ? " off" : "")); b.type = "button"; const dot = el("i"); dot.style.background = color; b.appendChild(dot); b.appendChild(document.createTextNode(label + ": " + (unit === "MB" ? D.fmtMB(Math.max(0, last)) : Math.round(Math.max(0, last)) + (unit === "%" ? "%" : " °C"))));
    b.onclick = () => { if (OPEN.off.has(key)) OPEN.off.delete(key); else OPEN.off.add(key); store.set("chartOff", [...OPEN.off]); drawChart(); }; lg.appendChild(b);
    if (OPEN.off.has(key)) continue;
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath(); let pen = false;
    for (const row of rows) { const val = row[idx]; if (val < 0) { pen = false; continue; } const p = unit === "MB" ? (val / max) * 100 : val; if (pen) g.lineTo(X(row[0]), Y(p)); else { g.moveTo(X(row[0]), Y(p)); pen = true; } }
    g.stroke();
  }
  if (rows.some((x) => x[9] > 0)) { const n = el("span", "kv", "Red bands: the window wasn't responding"); lg.appendChild(n); }
}
addEventListener("resize", () => { if (OPEN && !$("repView").hidden) drawChart(); });

/* ---------------------------------------------------------------- reading a collected file */
let VIEW = { errs: [], at: -1 };
async function viewFile(name, line) {
  const x = await N.file(OPEN.id, name); if (!x.ok) throw new Error("That file couldn't be read: " + x.error);
  $("viewName").textContent = name; $("viewFind").value = ""; const pre = $("viewText"); pre.textContent = "";
  const lines = x.text.split(/\r?\n/), cap = 20000, start = Math.max(0, lines.length - cap), frag = document.createDocumentFragment(); VIEW = { errs: [], at: -1 };
  if (start) frag.appendChild(el("span", "e", "[… the first " + start + " lines are not shown here; the whole file is in the report's folder …]\n"));
  for (let i = start; i < lines.length; i++) { const l = lines[i], isErr = l.length < 4000 && D.LOG_PATTERNS.some(([, re]) => re.test(l)); const s = el("span", isErr ? "e" : null, l + "\n"); s.dataset.n = i + 1; if (isErr) VIEW.errs.push(s); frag.appendChild(s); }
  pre.appendChild(frag); $("viewer").hidden = false; $("viewErr").hidden = !VIEW.errs.length; $("viewErr").textContent = VIEW.errs.length ? "Next error (" + VIEW.errs.length + ")" : "";
  const target = line ? pre.querySelector('span[data-n="' + line + '"]') : VIEW.errs[VIEW.errs.length - 1]; if (target) { target.scrollIntoView({ block: "center" }); VIEW.at = VIEW.errs.indexOf(target); } else pre.scrollTop = pre.scrollHeight;
}
$("viewBack").onclick = () => { $("viewer").hidden = true; $("viewText").textContent = ""; };
$("viewErr").onclick = () => { if (!VIEW.errs.length) return; VIEW.at = (VIEW.at + 1) % VIEW.errs.length; VIEW.errs[VIEW.at].scrollIntoView({ block: "center" }); };
$("viewFind").onkeydown = (e) => { if (e.key !== "Enter") return; const q = $("viewFind").value.trim().toLowerCase(); if (!q) return; const spans = [...$("viewText").children], from = VIEW.found === undefined ? 0 : VIEW.found + 1; for (let k = 0; k < spans.length; k++) { const i = (from + k) % spans.length; if (spans[i].textContent.toLowerCase().includes(q)) { VIEW.found = i; spans[i].scrollIntoView({ block: "center" }); spans[i].animate([{ background: "rgba(227,179,65,.5)" }, { background: "transparent" }], 1200); return; } } toast("Not found in this file."); };

/* ---------------------------------------------------------------- Fixes from the web
 * Two parts. Searches that open in the browser, already written for this game and this error (nothing needed for those).
 * And, with the Claude key from Settings, "Find fixes with Claude": Claude searches the web for this game and this error
 * and lists the fixes people report, each with the page it came from. */
function fixTerms(r, a) {
  const game = r.game.name, mod = (a.module || "").replace(/^.*[\\/]/, ""), words = [];
  const msg = ((r.logHits || []).filter((h) => h.tag === "crash" || h.tag === "gpu" || h.tag === "vram").slice(-1)[0] || {}).text || "";
  const short = msg.replace(/^\[[^\]]*\]\s*/g, "").replace(/0x[0-9a-f]{8,}/gi, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 9).join(" ");
  const what = r.platform === "linux" && r.game && r.game.wine && a.kind !== "normal" ? "Proton " + (a.kind === "gpu" ? "graphics crash" : a.kind === "start" ? "won't start" : "crash") : a.kind === "start" ? "closes right after starting" : a.kind === "gpu" ? "graphics driver crash" : a.kind === "vram" ? "out of video memory" : a.kind === "oom" ? "out of memory crash" : a.kind === "hang" ? "freezes not responding" : a.kind === "pc" ? "PC restarts blue screen" : "crash";
  words.push([game + " " + what + " fix", "The problem in general"]);
  if (r.platform === "linux" && r.exit && r.exit.signal) words.push([game + " " + (r.game && r.game.wine ? "Proton " : "Linux ") + ({ SIGSEGV: "segfault", SIGABRT: "abort", SIGBUS: "bus error", SIGILL: "illegal instruction", SIGFPE: "floating point exception" }[r.exit.signal] || r.exit.signal) + " crash", "This error"]);          // a Linux crash is searched the way Linux players write it
  else if (a.errName) words.push([game + " " + a.errName + (a.errCode ? " 0x" + (a.errCode >>> 0).toString(16).toUpperCase() : ""), "This error"]);
  if (mod && !/^(ntdll|kernelbase|kernel32|ucrtbase)\.dll$/i.test(mod) && mod.toLowerCase() !== String(r.game.exe).toLowerCase()) words.push([game + " " + mod + " crash", "The file it crashed in"]);
  if (short.length > 12) words.push([game + ' "' + short + '"', "The line in its log"]);
  return words;
}
function fixesCard(r, a, id) {
  const c = el("div", "card"); c.style.marginTop = "10px"; c.appendChild(el("div", "sec", "Fixes from the web")); c.firstChild.style.marginTop = "0";
  c.appendChild(el("div", "kv", "Searches written for this game and this error. They open in your browser."));
  const link = (label, url, title) => { const x = el("a", "chiplink", label); x.href = url; x.target = "_blank"; x.rel = "noopener"; if (title) x.title = title; return x; };
  const enc = encodeURIComponent, game = r.game.name;
  for (const [q, label] of fixTerms(r, a)) {
    const row = el("div", "fixrow"); const t = el("div", "t"); t.appendChild(el("small", null, label)); t.appendChild(el("b", null, q)); row.appendChild(t);
    row.appendChild(link("Web", "https://search.brave.com/search?q=" + enc(q), "Search the web")); row.appendChild(link("Reddit", "https://search.brave.com/search?q=" + enc(q + " site:reddit.com"), "What players say on Reddit")); row.appendChild(link("Steam", "https://search.brave.com/search?q=" + enc(q + " site:steamcommunity.com"), "The game's Steam discussions"));
    c.appendChild(row);
  }
  const more = el("div", "row"); more.style.marginTop = "8px"; more.appendChild(link("PCGamingWiki: " + game, "https://www.pcgamingwiki.com/w/index.php?search=" + enc(game), "Known issues and fixes for this game")); c.appendChild(more);
  const out = el("div"); out.id = "fixOut"; out.style.marginTop = "10px"; c.appendChild(out);
  const kept = store.get("fix:" + id, null); if (kept && kept.text) drawFixes(out, kept);
  if (hasClaude()) more.appendChild(btn("", kept && kept.text ? "✨ Search again with Claude" : "✨ Find fixes with Claude", () => findFixes(), "Claude searches the web for this game and this error (a few cents from your API balance)"));
  else more.appendChild(el("span", "kv", "Add a Claude API key in Settings and Claude can search and sum up the fixes here."));
  return c;
}
function drawFixes(out, x) {
  out.textContent = ""; const t = el("div", "fixtext", x.text); out.appendChild(t);
  if ((x.links || []).length) { out.appendChild(el("div", "sec", "Where this comes from")); const ul = el("ol", "tips"); for (const l of x.links) { const li = el("li"), aEl = el("a", null, l.title || l.url); aEl.href = l.url; aEl.target = "_blank"; aEl.rel = "noopener"; li.appendChild(aEl); li.appendChild(el("small", "kv", "  " + String(l.url).replace(/^https?:\/\/(www\.)?/, "").split("/")[0])); ul.appendChild(li); } out.appendChild(ul); }
  out.appendChild(el("div", "kv", "Found on the web by Claude" + (x.at ? " on " + new Date(x.at).toLocaleDateString() : "") + ". These are other players' fixes: check a page before following it, and never turn off your antivirus or download a \"fix\" program because a forum post says so."));
}
async function findFixes() {
  const { r, a, id } = OPEN, out = $("fixOut"); if (!hasClaude() || !out) return;
  out.textContent = "Claude is searching the web for this game and this error… (this can take a minute)";
  const sys = r.system || {}, gpu = ((sys.gpus || [])[0] || {}).name || "", terms = fixTerms(r, a).map((x) => x[0]).join(" | ");
  const hits = (r.logHits || []).slice(-12).map((h) => h.text).join("\n").slice(0, 2500);
  const prompt = "A PC game has a problem and I need fixes that other players or the developer have reported on the web for THIS game and THIS problem.\n\nGame: " + r.game.name + (r.game.version ? " (version " + r.game.version + ")" : "") + (r.game.company ? ", by " + r.game.company : "") + "\nProgram: " + r.game.exe + "\nWhat happened: " + a.title + ". " + a.why + (a.errName ? "\nError: " + a.errName + (a.errCode ? " 0x" + (a.errCode >>> 0).toString(16) : "") : "") + (a.module ? "\nFile it crashed in: " + a.module : "") + (hits ? "\nLines from the game's log:\n" + hits : "") + ((r.crashFiles || []).length ? "\nCrash files left behind: " + r.crashFiles.join(", ") : "") + "\nPC: " + [sys.os, gpu, sys.gpuDriver ? "driver " + sys.gpuDriver : ""].filter(Boolean).join(", ") + "\nSearches to start from: " + terms + "\n\nSearch the web (the game's Steam discussions, Reddit, PCGamingWiki, the developer's or publisher's support pages, patch notes). Then answer in plain text, no markdown symbols: first one sentence saying whether this is a known problem for this game. Then a numbered list of at most 6 fixes, most likely first; for each: what to do in concrete steps, and where it was reported (site name). Only include fixes that pages you found actually describe for this game or this exact error; if you found nothing specific to this game, say so plainly and give the fixes for the error in general instead. Never suggest turning off antivirus or security features, or downloading files from unofficial sites.";
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  const messages = [{ role: "user", content: prompt }]; let blocks = [];
  for (let turn = 0; turn < 4; turn++) {                 // a long search can pause: the paused answer is sent back as it is and it carries on
    const res = await claude({ model: store.get("aiModel", "claude-sonnet-5-5"), max_tokens: 3000, tools, messages });
    let j = null; try { j = JSON.parse(res.body); } catch (e) {}
    if (!res.ok || res.status !== 200) { const m = (j && j.error && j.error.message) || ""; out.textContent = !res.ok ? "Couldn't reach Claude. Check the internet connection." : res.status === 401 ? (useSrv() ? "Your Sync sign-in has ended: sign in again in Settings > Sync." : "That Claude API key isn't accepted. Check it in Settings.") : /credit balance/i.test(m) ? "Your Claude API balance is empty (Claude Console > Billing)." : /web search|web_search/i.test(m) ? "Web search isn't turned on for your Claude API account (Claude Console > Settings > Privacy). " + m : m || "Claude answered with an error (" + res.status + ")."; alog("find fixes: " + res.status + " " + m.slice(0, 300), true); return; }
    blocks = blocks.concat(j.content || []);
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const links = [], seen = new Set(), add = (u, t) => { if (!/^https:\/\//.test(String(u)) || seen.has(u) || links.length >= 12) return; seen.add(u); links.push({ url: u, title: String(t || "").slice(0, 140) }); };
  for (const b of blocks) if (b.type === "text") for (const ci of b.citations || []) add(ci.url, ci.title);
  if (!links.length) for (const b of blocks) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const x of b.content.slice(0, 4)) add(x.url, x.title);
  if (!text) { out.textContent = "Claude sent an empty answer. Try again."; return; }
  const x = { text, links, at: Date.now() }; store.set("fix:" + id, x); drawFixes(out, x);
}

/* ---------------------------------------------------------------- Explain with Claude */
/* Claude: through the user's sync server when that's chosen (Settings > AI), otherwise straight to Anthropic with
   the key entered here. Same answer either way: { ok, status, body }. */
let AI_SRV = false, AI_SRV_DEF = false;          // the shared copy: off until the user turns it on
const useSrv = () => AI_SRV && store.get("aiSrv", AI_SRV_DEF) === true;
const hasClaude = () => useSrv() || !!String(store.get("aiKey", "") || "").trim();
async function claude(request) {
  if (useSrv()) return N.ai("send", request);
  const headers = { "content-type": "application/json", "x-api-key": String(store.get("aiKey", "") || "").trim(), "anthropic-version": "2023-06-01" };
  return window.native.httpPost("https://api.anthropic.com/v1/messages", headers, JSON.stringify(request));
}
/* For the PC tab's "Ask about it" box: one question, answered by whichever AI is set up in Settings → AI.
   { ok, text } or { ok: false, error }. */
window.askAI = async function (prompt) {
  if (store.get("aiLocal", false)) {
    const base = String(store.get("aiLocalUrl", "") || "http://127.0.0.1:11434").trim().replace(/\/+$/, ""), model = String(store.get("aiLocalModel", "") || "qwen3:32b").trim();
    const lr = await window.native.httpPost(base + "/api/chat", { "content-type": "application/json" }, JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }));
    let lj = null; try { lj = JSON.parse(lr.body); } catch (e) {}
    if (!lr.ok || lr.status !== 200) return { ok: false, error: "The local AI model isn't answering at " + base + "." };
    return { ok: true, text: String((lj && lj.message && lj.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() };
  }
  if (!hasClaude()) return { ok: false, error: "none" };
  const res = await claude({ model: store.get("aiModel", "claude-sonnet-5-5"), max_tokens: 1200, messages: [{ role: "user", content: prompt }] });
  let j = null; try { j = JSON.parse(res.body); } catch (e) {}
  if (!res.ok || res.status !== 200) return { ok: false, error: !res.ok ? "Couldn't reach Claude." : res.status === 401 ? (useSrv() ? "Your Sync sign-in has ended: sign in again in Settings > Sync." : "That Claude API key isn't accepted. Check it in Settings.") : (j && j.error && j.error.message) || "Claude answered " + res.status + "." };
  return { ok: true, text: ((j && j.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim() };
};
async function explain() {
  const { r, a, id } = OPEN, local = !!store.get("aiLocal", false); if (!hasClaude() && !local) return;
  const card = $("aiCard"), out = $("ai"); card.hidden = false; out.textContent = (local ? "The local AI model" : "Claude") + " is reading the report…"; card.scrollIntoView({ block: "nearest" });
  const hits = (r.logHits || []).slice(-50).map((h) => "[" + h.file + ":" + h.n + "] " + h.text).join("\n");
  let tailText = ""; const main = (r.files || []).filter((f) => f.name && f.kind === "game-log" && !/\.(dmp|mdmp|hdmp)$/i.test(f.name)).sort((x, y) => (y.hits || 0) - (x.hits || 0) || y.mtime - x.mtime)[0];
  if (main) { const x = await N.file(id, main.name); if (x.ok) tailText = x.text.split(/\r?\n/).slice(-120).join("\n").slice(-9000); }
  const evs = (r.events || []).filter((e) => e.level <= 3).slice(-12).map((e) => new Date(e.t).toLocaleTimeString() + " " + e.provider + " " + e.id + ": " + String(e.message || (e.data || []).join(" | ")).replace(/\s+/g, " ").slice(0, 500)).join("\n");
  const prompt = "A PC game ended abnormally. Below is an automatic report from a monitoring tool. Explain to the player, in plain words and without jargon, (1) what most likely happened, (2) how sure you are and what the evidence is, (3) what to try, most likely fix first (at most 6 steps, concrete: which setting, which driver, which file). If the evidence points to a bug in the game itself, say so plainly and say what to send to the developer. Do not invent facts that are not in the report. Plain text, short paragraphs and a numbered list; no markdown symbols.\n\n=== SUMMARY ===\n" + D.summaryText(r, a) + "\n\n=== THINGS THE TOOL NOTICED ===\n" + (a.findings.map((f) => f.title + ": " + f.text).join("\n") || "nothing else") + "\n\n=== ERROR LINES FROM THE GAME'S LOGS ===\n" + (hits || "none found") + (tailText ? "\n\n=== LAST LINES OF " + main.name + " ===\n" + tailText : "") + "\n\n=== WINDOWS EVENTS ===\n" + (evs || "none") + "\n\n=== ALSO RUNNING ===\n" + ((r.others || []).join(", ") || "nothing notable");
  if (local) {
    // Ollama on this PC: the report doesn't leave it
    const base = String(store.get("aiLocalUrl", "") || "http://127.0.0.1:11434").trim().replace(/\/+$/, ""), model = String(store.get("aiLocalModel", "") || "qwen3:32b").trim();
    const lr = await window.native.httpPost(base + "/api/chat", { "content-type": "application/json" }, JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }));
    let lj = null; try { lj = JSON.parse(lr.body); } catch (e) {}
    if (!lr.ok || lr.status !== 200) { out.textContent = lr.error === "not-allowed" ? "The local AI address must be on this PC (http://127.0.0.1:port)." : !lr.ok ? "Ollama isn't answering at " + base + ". Start it (it runs next to the clock), or install it from ollama.com." : /not found/i.test((lj && lj.error) || "") ? "Ollama doesn't have " + model + " yet. In a terminal: ollama pull " + model : "The local AI answered " + lr.status + ": " + ((lj && lj.error) || "").slice(0, 200); return; }
    const text = String((lj && lj.message && lj.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "The local AI sent an empty answer.";
    out.textContent = text; store.set("ai:" + id, text); return;
  }
  const res = await claude({ model: store.get("aiModel", "claude-sonnet-5-5"), max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
  let j = null; try { j = JSON.parse(res.body); } catch (e) {}
  if (!res.ok || res.status !== 200) { out.textContent = res.ok ? (res.status === 401 ? (useSrv() ? "Your Sync sign-in has ended: sign in again in Settings > Sync." : "That Claude API key isn't accepted. Check it in Settings.") : /credit balance/i.test((j && j.error && j.error.message) || "") ? "Your Claude API balance is empty (Claude Console > Billing)." : (j && j.error && j.error.message) || "Claude answered with an error (" + res.status + ").") : "Couldn't reach Claude. Check the internet connection."; return; }
  const text = ((j && j.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim() || "Claude sent an empty answer.";
  out.textContent = text; store.set("ai:" + id, text);
}

/* ---------------------------------------------------------------- Settings */
function drawSettings() {
  const s = ST.settings || {};
  for (const [id, k] of [["oAuto", "auto"], ["oStartup", "startup"], ["oNotify", "notify"], ["oNormal", "keepNormal"]]) { $(id).checked = !!s[k]; $(id).onchange = guard(async () => { await N.settings({ [k]: $(id).checked }); refresh(); }); }
  const chips = (box, key, opts) => { box.textContent = ""; for (const [val, label] of opts) { const b = el("button", s[key] === val ? "on" : "", label); b.type = "button"; b.onclick = guard(async () => { await N.settings({ [key]: val }); refresh(); }); box.appendChild(b); } };
  chips($("oInterval"), "interval", [[1000, "1 s"], [2000, "2 s"], [5000, "5 s"]]); chips($("oKeep"), "keep", [[10, "10"], [25, "25"], [50, "50"], [100, "100"]]);
}
$("aiKey").value = store.get("aiKey", ""); $("aiKey").onchange = () => { store.set("aiKey", $("aiKey").value.trim()); if (OPEN) drawReport(); };
$("aiModel").value = store.get("aiModel", "claude-sonnet-5-5"); $("aiModel").onchange = () => store.set("aiModel", $("aiModel").value);
async function aiSrvState() { const x = N && N.ai ? await N.ai("can") : null; AI_SRV = !!(x && x.can); AI_SRV_DEF = !!(x && !x.shared); $("aiSrvWrap").hidden = !AI_SRV; $("aiSrv").checked = store.get("aiSrv", AI_SRV_DEF) === true; if (OPEN) drawReport(); }
$("aiSrv").onchange = () => { store.set("aiSrv", $("aiSrv").checked); if (OPEN) drawReport(); };
aiSrvState();
$("aiLocal").checked = !!store.get("aiLocal", false); $("aiLocalRow").hidden = !$("aiLocal").checked;
$("aiLocal").onchange = () => { store.set("aiLocal", $("aiLocal").checked); $("aiLocalRow").hidden = !$("aiLocal").checked; if (OPEN) drawReport(); };
$("aiLocalModel").value = store.get("aiLocalModel", ""); $("aiLocalModel").onchange = () => store.set("aiLocalModel", $("aiLocalModel").value.trim());
$("aiLocalUrl").value = store.get("aiLocalUrl", ""); $("aiLocalUrl").onchange = () => store.set("aiLocalUrl", $("aiLocalUrl").value.trim());
$("bFolder").onclick = () => N && N.folder("");
/* Sync: the games list and the hidden list, on the user's own server */
async function drawSync() {
  if (!N || !N.sync) return;
  const s = await N.sync("state"); const on = !!s.signedIn; aiSrvState();
  $("syIn").hidden = on; $("sySrvBox").hidden = on; $("syOut").hidden = !on; if (!on && !$("sySrv").value) $("sySrv").value = s.server || "";
  $("syWho").textContent = on ? "Signed in as " + s.user : "";
  $("syMsg").textContent = s.error ? "Sync didn't work: " + s.error : on ? (s.at ? "Last synced " + new Date(s.at).toLocaleString() + "." : "Not synced yet.") : "";
}
$("syGo").onclick = guard(async () => { const r = await N.sync("login", { user: $("syUser").value.trim(), pass: $("syPass").value, server: $("sySrv").value.trim() }); if (!r.ok) throw new Error(r.error || "Couldn't sign in."); $("syPass").value = ""; toast("Signed in. Your lists are synced."); await refresh(); drawSync(); });
$("syBye").onclick = guard(async () => { await N.sync("logout"); drawSync(); });
$("syNow").onclick = guard(async () => { const r = await N.sync("now"); await refresh(); drawSync(); if (!r.ok) throw new Error(r.error || "Sync didn't work."); toast("Synced."); });
if (CFG.share) $("sySrvBox").closest(".card").hidden = true;          // a copy given to someone else: no sync account to sign in to
else drawSync();

/* ---------------------------------------------------------------- wiring */
function show(tab) { if (tab !== "rep" && repOpen) { repOpen = false; repQuery = ""; drawReports(); } for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === tab); for (const t of ["games", "rep", "pc", "set"]) $("tab-" + t).hidden = t !== tab; if (tab === "pc" && window.pcShown) window.pcShown(); }
window.show = show;
$("tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (!b) return; if (b.dataset.tab === "rep" && !$("tab-rep").hidden) closeReport(); show(b.dataset.tab); };
$("bAddRun").onclick = guard(pick); $("pickClose").onclick = () => ($("picker").hidden = true);
$("bAddExe").onclick = guard(async () => { const x = await N.add({}); if (x.ok) { toast("Added. It is watched whenever it starts."); refresh(); } else if (!x.cancelled) throw new Error(x.error || "That couldn't be added."); });
// the games drop-down on the Reports tab closes when you click anywhere else
document.addEventListener("click", (e) => { if (repOpen && !e.target.closest("#repFilter")) { repOpen = false; repQuery = ""; drawReports(); } });
addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("viewer").hidden) $("viewBack").click(); else if (!$("picker").hidden) $("picker").hidden = true; } });
window.__agBack = () => { if (!$("viewer").hidden) { $("viewBack").click(); return true; } if (!$("picker").hidden) { $("picker").hidden = true; return true; } if (OPEN) { closeReport(); return true; } return false; };
(async function () {
  initUpdates();
  if (N) {
    let t = 0; N.on("diag-update", () => { clearTimeout(t); t = setTimeout(() => refresh().catch(() => {}), 250); });
    N.on("diag-live", (s) => { const box = document.getElementById("live-" + s.pid); if (box) paintLive(box, s); });
    N.on("diag-building", (x) => toast(x.name + " ended. Checking how it ended…", false, 60000));
    N.on("diag-report-ready", (x) => { if (x && x.name) toast(x.name + ": " + x.title + ". The report is in the Reports tab.", false, 9000); else $("toast").hidden = true; });
    N.on("diag-closed", (x) => { if (x && x.error) toast("The report for " + x.name + " couldn't be built: " + x.error, true, 9000); else toast(((x && x.name) || "The game") + " closed normally: no crash found, so no report was kept.", false, 6000); });
    N.on("diag-open", guard((id) => openReport(id)));
    N.on("diag-log", (l) => alog(l, true));       // what the watcher saw and decided, for the app's log
  }
  await refresh().catch((e) => toast(plain(e), true, 6000));
  setInterval(() => { if (!document.hidden && $("tab-games").hidden === false && ST.games.some((g) => g.running)) for (const c of $("games").children) { const g = ST.games.find((x) => x.key === c.dataset.key); if (g && g.running) c.querySelector(".kv").textContent = "Playing now · started " + ago(g.running.since) + (g.running.title && g.running.title !== g.name ? " · " + g.running.title : ""); } }, 30000);
  alog("opened");
})();
