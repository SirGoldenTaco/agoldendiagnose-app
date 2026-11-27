/* aGoldenDiagnose: the PC tab. Live readings of the PC and the internet, "Check my PC", and the incidents list.
 * Everything is measured by the Windows app (desktop/pc.js); this file only draws it. */
"use strict";
(function () {
  const P = window.native && window.native.diag && window.native.diag.pc ? window.native.diag : null;
  let PS = null, LIVE = null, openInc = "", checking = false;
  const gb = (b) => (b / 1073741824).toFixed(b < 10737418240 ? 1 : 0) + " GB";
  const rate = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB/s" : b >= 1024 ? Math.round(b / 1024) + " KB/s" : Math.round(b) + " B/s");
  const span = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : s < 172800 ? (s / 3600).toFixed(1) + " h" : Math.round(s / 86400) + " days"; };
  const ago = (t) => { const d = Date.now() - t; return d < 60000 ? "just now" : span(d) + " ago"; };
  const SEV = { bad: ["Problem", "bad"], warn: ["Warning", "warn"], info: ["Note", "info"], ok: ["OK", "ok"] };

  /** A small line chart in a canvas: values 0..max (negative = no reading, drawn as a gap). */
  function spark(cv, rows, idx, max, color) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 200, h = cv.clientHeight || 44;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    if (!rows || rows.length < 2) return;
    const vals = rows.map((r) => r[idx]), top = max || Math.max(10, ...vals.filter((v) => v > 0)) * 1.15, n = Math.max(2, vals.length), step = w / (n - 1), off = 0;
    g.lineWidth = 1.6; g.strokeStyle = color; g.lineJoin = "round"; g.beginPath(); let pen = false;
    vals.forEach((v, i) => { if (v == null || v < 0) { pen = false; return; } const x = (off + i) * step, y = h - 2 - Math.min(1, v / top) * (h - 4); if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; } });
    g.stroke();
    // a lost answer: a red tick at the bottom
    g.fillStyle = "#ff7b72"; vals.forEach((v, i) => { if (v != null && v < 0 && color === "#58a6ff") g.fillRect((off + i) * step - 1, h - 5, 2, 5); });
  }
  // A tile: label, big value, a few labelled lines (always the same lines, so the tile never changes height), a chart.
  // Clicking it opens that part in detail.
  function tile(id, label, which) {
    let t = document.getElementById(id); if (t) return t;
    t = el("div", "pctile"); t.id = id; t.tabIndex = 0; t.setAttribute("role", "button"); t.title = "Open " + label.toLowerCase() + " in detail";
    t.appendChild(el("div", "lbl", label)); t.appendChild(el("div", "big")); t.appendChild(el("div", "rows")); const c = el("canvas", "spark"); t.appendChild(c);
    if (which) { t.onclick = () => openDetail(which); t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(which); } }; }
    $("pcTiles").appendChild(t); return t;
  }
  function setTile(id, label, big, rows, cls, which) {
    const t = tile(id, label, which); t.children[1].textContent = big; t.className = "pctile" + (cls ? " " + cls : "");
    const box = t.children[2]; box.textContent = "";
    for (const [k, v] of Array.isArray(rows) ? rows : [["", rows || ""]]) { const r = el("div", "trow"); r.appendChild(el("span", "k", k)); r.appendChild(el("span", "v", v === "" || v == null ? "—" : v)); box.appendChild(r); }
    return t.children[3];
  }
  const deg = (c) => (c > 0 ? Math.round(c) + " °C" : "");

  function drawQuick() {
    if (document.getElementById("pcQuick") || !WIN) return;
    const c = el("details", "card"); c.id = "pcQuick"; c.style.marginTop = "10px"; c.open = store.get("pcQuickOpen", true) !== false;
    c.addEventListener("toggle", () => store.set("pcQuickOpen", c.open));
    const sm = el("summary", "sec", "Windows shortcuts"); sm.style.cssText = "cursor:pointer;margin:0"; c.appendChild(sm);
    const r = quickRow(Object.keys(QUICK)); r.style.marginTop = "8px"; c.appendChild(r);
    $("pcTiles").after(c);
  }
  function drawLive() {
    const L = LIVE; if (!L || $("tab-pc").hidden) return;
    const p = L.pc, n = L.net, ch = L.chart || {};
    $("pcOff").hidden = !!L.on; $("pcBody").hidden = !L.on;
    if (!L.on) return;
    // The tiles are always there (so the tab never looks empty); they read "…" until the first measurement arrives.
    const ram = p && p.ramTotal ? (1 - p.ramFree / p.ramTotal) * 100 : -1, T = L.temps || {};
    spark(setTile("tCpu", "Processor", p && p.cpu >= 0 ? Math.round(p.cpu) + "%" : "…", [["Temp", deg(T.cpu) || (p ? "not read" : "")], ["Threads", p && p.cores ? String(p.cores) : ""], ["Programs", p && p.procs ? String(p.procs) : ""]], (p && p.cpu >= 96) || T.cpu >= 90 ? "warn" : "", "cpu"), ch.pc, 1, 100, "#e3b341");
    spark(setTile("tRam", "Memory", ram >= 0 ? Math.round(ram) + "%" : "…", [["Used", p && p.ramTotal ? gb(p.ramTotal - p.ramFree) + " / " + gb(p.ramTotal) : ""], ["Free", p && p.ramTotal ? gb(p.ramFree) : ""], T.ram > 0 ? ["Temp", deg(T.ram)] : ["Commit", p && p.commitTotal ? Math.round((1 - p.commitFree / p.commitTotal) * 100) + "%" : ""]], ram >= 92 ? "warn" : "", "ram"), ch.pc, 2, 100, "#56d364");
    spark(setTile("tGpu", "Graphics card", p ? (p.gpu >= 0 ? Math.round(p.gpu) + "%" : "n/a") : "…", [["Temp", p ? deg(p.gpuTemp) : ""], ["VRAM", p && p.vramMB > 0 ? (p.vramMB / 1024).toFixed(1) + (p.vramTotalMB > 0 ? "/" + Math.round(p.vramTotalMB / 1024) : "") + " GB" : ""], ["Power", p ? [p.gpuPower > 0 ? Math.round(p.gpuPower) + " W" : "", p.gpuFan >= 0 ? Math.round(p.gpuFan) + "%" : ""].filter(Boolean).join(" · ") : ""]], p && p.gpuTemp >= 87 ? "warn" : "", "gpu"), ch.pc, 3, 100, "#d2a8ff");
    if (!L.netOn) setTile("tNet", "Internet", "Off", [["Watching", "off in Settings"], ["", ""], ["", ""]], "", "net");
    else if (n) {
      const st = n.state || "ok", name = { ok: "Online", cable: "Disconnected", router: "Router silent", down: "No internet", dns: "DNS failing", slow: "Unstable" }[st];
      spark(setTile("tNet", "Internet", name, [["Internet", n.best > 0 ? n.best + " ms" : "no answer"], ["Router", n.gatewayMs > 0 ? n.gatewayMs + " ms" : "no answer"], ["Lost", (n.loss || 0) + "%"]], st === "ok" ? "good" : st === "slow" || st === "dns" ? "warn" : "bad", "net"), ch.net, 1, 0, "#58a6ff");
    } else setTile("tNet", "Internet", "…", [["Internet", ""], ["Router", ""], ["Lost", ""]], "", "net");
    // what is going through the network card right now
    const main = p ? (p.nets || []).find((x) => x.up && x.gateway) || (p.nets || []).find((x) => x.up) : null;
    spark(setTile("tLink", "Network", p ? "↓ " + rate(p.rx || 0) : "…", [["Upload", p ? "↑ " + rate(p.tx || 0) : ""], ["Link", main ? (main.wifi ? "Wi-Fi" : "Cable") + (main.mbps ? " · " + (main.mbps >= 1000 ? main.mbps / 1000 + " Gbps" : main.mbps + " Mbps") : "") : p ? "none" : ""], ["Card", main ? main.name : ""]], main && !main.wifi && main.mbps > 0 && main.mbps <= 100 ? "warn" : "", "link"), ch.pc, 5, 0, "#79c0ff");
    if (DET.which) drawDetailLive();
    drawQuick();
    // drives and "right now": filled from the live reading, or a short note while there isn't one yet
    const drives = $("pcDrives"), tp = $("pcTop");
    if (p && (p.drives || p.topCpu)) {
      drives.textContent = "";
      const dT = (name) => { const x = ((L.temps || {}).drives || []).find((t) => (" " + (t.letters || "") + " ").includes(" " + name + " ")); return x ? x.c : 0; };
      for (const d of p.drives || []) { const used = d.total ? 1 - d.free / d.total : 0, r = el("div", "drv" + (used > 0.95 ? " bad" : used > 0.88 ? " warn" : "")); r.appendChild(el("b", null, d.name + (d.label ? "  " + d.label : ""))); const bar = el("div", "bar"), fill = el("i"); fill.style.width = Math.round(used * 100) + "%"; bar.appendChild(fill); r.appendChild(bar); r.appendChild(el("small", null, gb(d.free) + " free of " + gb(d.total) + (dT(d.name) ? " · " + dT(d.name) + " °C" : ""))); drives.appendChild(r); }
      tp.textContent = "";
      const col = (title, list, fmt) => { const c = el("div", "topcol"); c.appendChild(el("div", "lbl", title)); for (const x of (list || []).slice(0, 5)) { const r = el("div", "toprow"); r.appendChild(el("span", "n", x.name)); r.appendChild(el("span", "v", fmt(x))); c.appendChild(r); } tp.appendChild(c); };
      col("Using the processor most", p.topCpu, (x) => x.cpu + "%"); col("Using the most memory", p.topMem, (x) => gb(x.mem));
      $("pcUp").textContent = p.upMs ? "Windows has been running for " + span(p.upMs) + "." : "";
    } else if (!drives.children.length) { drives.textContent = ""; drives.appendChild(el("div", "kv", L.helper ? "Reading your PC…" : "Waiting for the watcher to start…")); tp.textContent = ""; $("pcUp").textContent = ""; }
    // the line at the top: is anything wrong right now?
    const open = (PS ? PS.incidents : []).filter((i) => i.open), head = $("pcHead");
    head.className = "banner" + (open.length ? " bad is-bad" : "");
    $("pcDot").className = "dot";
    $("pcLine").textContent = !L.helper ? "The watcher isn't running; it restarts by itself in a few seconds." : open.length ? open.map((i) => i.title).join(" · ") : p ? "Nothing wrong right now. The PC and the internet are being watched." : "Starting up — reading your PC…";
  }

  // Buttons that go with a step: Windows tools opened directly (only on Windows), and pages to download from.
  // Found from what the step says, so every step that names a tool or a download gets its button.
  const WIN = !/Linux/.test(navigator.userAgent);
  const G = (x) => "https://www.google.com/search?q=" + encodeURIComponent(x);
  const STEP_BUTTONS = [
    [/Device Manager/, { label: "Open Device Manager", tool: "devmgmt" }],
    [/Task Manager/, { label: "Open Task Manager (Startup apps)", tool: "taskmgr" }],
    [/Windows Update/, { label: "Open Windows Update", tool: "update" }],
    [/Storage Sense|System → Storage|Temporary files/, { label: "Open Storage settings", tool: "storage" }],
    [/Power mode/, { label: "Open Power settings", tool: "power" }],
    [/File History|Backup options/, { label: "Open Backup settings", tool: "backup" }],
    [/Windows Security/, { label: "Open Windows Security", tool: "security" }],
    [/Windows Memory Diagnostic/, { label: "Open Windows Memory Diagnostic", tool: "mdsched" }],
    [/Virtual memory|Advanced system settings/, { label: "Open Advanced system settings", tool: "sysadv" }],
    [/Disk Cleanup/, { label: "Open Disk Cleanup", tool: "diskclean" }],
    [/troubleshooter/, { label: "Open Troubleshoot", tool: "troubleshoot" }],
    [/Outage report/, { label: "Open the outage report", tool: "outage" }],
    [/WinDbg/, { label: "WinDbg (Microsoft Store)", url: "https://apps.microsoft.com/detail/9pgjgd53tn86" }],
    [/BlueScreenView/, { label: "BlueScreenView", url: "https://www.nirsoft.net/utils/blue_screen_view.html" }],
    [/MemTest86/, { label: "MemTest86", url: "https://www.memtest86.com/" }],
    [/LibreHardwareMonitor/, { label: "LibreHardwareMonitor (download)", url: "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases" }],
    [/Clonezilla/, { label: "Clonezilla", url: "https://clonezilla.org/" }],
    [/Samsung Magician/, { label: "Samsung Magician", url: "https://semiconductor.samsung.com/consumer-storage/support/tools/" }],
    [/NVIDIA/, { label: "NVIDIA drivers", url: "https://www.nvidia.com/en-us/drivers/" }],
    [/\bAMD\b|Adrenalin/, { label: "AMD drivers", url: "https://www.amd.com/en/support/download/drivers.html" }],
    [/Intel/, { label: "Intel Driver & Support Assistant", url: "https://www.intel.com/content/www/us/en/support/detect.html" }],
    [/chipset/, { label: "AMD chipset drivers", url: "https://www.amd.com/en/support/download/drivers.html" }],
  ];
  function stepButtons(texts, extra) {
    const all = (extra || []).slice(), txt = texts.join(" ");
    for (const [re, b] of STEP_BUTTONS) if (re.test(txt) && !all.some((x) => x.label === b.label)) all.push(b);
    const m = /support page for the (.+?)\./.exec(txt); if (m) all.push({ label: "BIOS for the " + m[1], url: G(m[1] + " BIOS download support") });
    const list = all.filter((b) => b.url || b.tool === "outage" || WIN); if (!list.length) return null;
    const w = el("div", "stepbtns");
    for (const b of list) w.appendChild(btn("ghost small", (b.url ? "↗ " : "") + b.label, async () => {
      if (b.url) return window.native.openUrl(b.url);
      if (b.tool === "outage") { if (DET.which) closeDetail(); const o = $("pcOut"); o.hidden = false; $("pcOutTo").value = new Date().toISOString().slice(0, 10); if (!$("pcOutFrom").value) $("pcOutFrom").value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); o.scrollIntoView({ block: "center" }); return; }
      const ok = await P.pc("open", { tool: b.tool }); if (!ok) toast("That opens on Windows only.");
    }, b.url ? b.url : ""));
    return w;
  }
  // Quick buttons to Windows' own tools: a row on the PC tab, and the ones that go with each tile on its page
  const QUICK = { devmgmt: "Device Manager", taskmgrnow: "Task Manager", taskmgr: "Startup apps", update: "Windows Update", netconn: "Network connections", network: "Network settings", display: "Display", graphics: "Graphics settings", sound: "Sound", power: "Power", storage: "Storage", diskmgmt: "Disk Management", reliability: "Reliability history", eventvwr: "Event Viewer", resmon: "Resource Monitor", sysadv: "Advanced system settings", apps: "Installed apps", security: "Windows Security", about: "About this PC" };
  const QUICK_FOR = { cpu: ["taskmgrnow", "resmon", "reliability", "power"], ram: ["taskmgrnow", "resmon", "sysadv"], gpu: ["devmgmt", "graphics", "display"], net: ["network", "netconn", "devmgmt"], link: ["devmgmt", "netconn", "network"] };
  function quickRow(keys) {
    if (!WIN) return null;
    const w = el("div", "stepbtns"); w.style.margin = "0";
    for (const k of keys) w.appendChild(btn("ghost small", QUICK[k], async () => { const ok = await P.pc("open", { tool: k }); if (!ok) toast("That opens on Windows only."); }));
    return w;
  }
  // "… for me": changes one setting of the network card (Windows asks for administrator rights). Two clicks: the first
  // says what will happen, the second does it. The change shows under "What you changed", with Undo.
  function fixBtn(f, why) {
    const b = el("button", "small", "⚡ " + f.label); b.type = "button"; let armed = false;
    b.onclick = async () => {
      if (!armed) { armed = true; b.textContent = "Sure? Windows will ask for administrator rights. Click again"; setTimeout(() => { if (armed && !b.disabled) { armed = false; b.textContent = "⚡ " + f.label; } }, 6000); return; }
      armed = false; b.disabled = true; b.textContent = "Changing it… (answer Windows' prompt)";
      const r = await P.pc("netfix", { setting: f.setting, value: f.value, why });
      b.disabled = false; b.textContent = "⚡ " + f.label;
      if (!r || !r.ok) return toast((r && r.error) || "It couldn't be changed.", true, 7000);
      toast(r.same ? "It was already set that way." : "Done. The connection blinks once. It's under What you changed (Network or Internet page), with Undo.", false, 7000);
      await load(); if (DET.which) { const d = await P.pc("detail", { which: DET.which }); if (DET.which) { DET.data = d; drawDetail(); } }
    };
    return b;
  }
  // "What you changed": your own notes and the app's own changes, with the drops per day before and after each one
  function changesSection(list, which) {
    const c = section("What you changed (" + list.length + ")");
    c.appendChild(el("p", "kv", "Note each thing you try (a new driver, another cable, another router port…). The app compares the drops per day in the 7 days before with the days since, so you can see whether it helped."));
    for (const ch of list.slice(0, 30)) {
      const r = el("div", "hrow"), t = el("div", "t"), hd = el("div", "row"); hd.style.cssText = "gap:8px;align-items:flex-start";
      hd.appendChild(el("b", "grow", ch.text + (ch.undone ? " (undone " + new Date(ch.undone).toLocaleDateString() + ")" : "")));
      if (ch.auto && !ch.undone && WIN) hd.appendChild(btn("ghost small", "Undo", async (e) => { const b = e && e.target; if (b) { b.disabled = true; b.textContent = "Undoing…"; } const x = await P.pc("netundo", { id: ch.id }); if (!x || !x.ok) throw new Error((x && x.error) || "It couldn't be undone."); toast("Put back as it was."); const d = await P.pc("detail", { which }); if (DET.which === which) { DET.data = d; drawDetail(); } }, "Put the setting back as it was (Windows asks for administrator rights)"));
      hd.appendChild(btn("ghost small", "✕", async () => { await P.pc("changes", { action: "remove", id: ch.id }); const d = await P.pc("detail", { which }); if (DET.which === which) { DET.data = d; drawDetail(); } }, "Remove this note (doesn't undo anything)"));
      t.appendChild(hd);
      const st = ch.stats || {}, f = (x) => (x == null ? "" : x < 0.1 && x > 0 ? x.toFixed(2) : x.toFixed(1));
      t.appendChild(el("small", null, new Date(ch.t).toLocaleString() + (ch.auto ? " · done by the app" : "")));
      t.appendChild(el("p", null, "Before: " + f(st.perDayBefore) + " drops a day (" + (st.before || 0) + " in the 7 days before). After: " + (st.perDayAfter == null ? "too soon to tell, check back tomorrow" : f(st.perDayAfter) + " a day (" + st.after + " in " + (st.afterDays >= 1 ? st.afterDays.toFixed(1) + " days" : Math.round(st.afterDays * 24) + " h") + ")" + (st.afterDays >= 2 && st.perDayBefore > 0 ? (st.perDayAfter < st.perDayBefore * 0.5 ? ": looks like it helped" : st.perDayAfter >= st.perDayBefore * 0.9 ? ": no better so far" : ": a bit better") : "")) + "."));
      r.appendChild(t); c.appendChild(r);
    }
    const add = el("div", "row"); add.style.cssText = "gap:8px;margin-top:8px;flex-wrap:wrap";
    const inp = el("input"); inp.placeholder = "What did you change? e.g. new Cat 6 cable"; inp.style.cssText = "flex:1;min-width:220px";
    const when = el("input"); when.type = "datetime-local"; const z = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); when.value = z.toISOString().slice(0, 16);
    add.appendChild(inp); add.appendChild(when);
    add.appendChild(btn("small", "Add", async () => { if (!inp.value.trim()) throw new Error("Write what you changed first."); await P.pc("changes", { action: "add", text: inp.value, t: new Date(when.value).getTime() || Date.now() }); const d = await P.pc("detail", { which }); if (DET.which === which) { DET.data = d; drawDetail(); } }));
    c.appendChild(add);
    return c;
  }
  // numbered steps; each item is a string, or {t: title, s: [steps], links: [{label, url}], open: [{label, tool}]}
  function stepsBox(steps, title) {
    const w = el("div", "steps"); if (title) w.appendChild(el("div", "lbl2", title));
    const loose = (steps || []).filter((x) => typeof x === "string");
    for (const st of steps || []) {
      if (typeof st === "string") { (w.lastChild && w.lastChild.tagName === "OL" ? w.lastChild : w.appendChild(el("ol"))).appendChild(el("li", null, st)); continue; }
      w.appendChild(el("b", null, st.t)); const ol = el("ol"); for (const x of st.s || []) ol.appendChild(el("li", null, x)); w.appendChild(ol);
      const bt = stepButtons([st.t].concat(st.s || []), (st.links || []).concat(st.open || [])); if (bt) w.appendChild(bt);
      if (st.fix && st.fix.length && WIN) { const fx = el("div", "stepbtns"); for (const f of st.fix) fx.appendChild(fixBtn(f, st.t)); w.appendChild(fx); }
    }
    if (loose.length) { const bt = stepButtons(loose); if (bt) w.appendChild(bt); }
    return w;
  }
  /* "Something doesn't match? Ask about it": under each problem. The question goes, with what the app found and
     suggested, to whichever AI is set up (Settings → AI); the answer stays under the problem. Without AI it can be
     reported instead: on the public copy as an issue on its GitHub page (the form opens filled in, nothing is sent
     until you post it), on the author's copy into the app's own log. */
  function askBox(key, title, ctx) {
    const d = el("details", "ask"), hist = store.get("ask:" + key, []) || [];
    d.open = hist.length > 0;
    d.appendChild(el("summary", null, hist.length ? "Questions about it (" + hist.length + ")" : "Something doesn't match, or a question? Ask about it"));
    for (const h of hist) { const q = el("p", "q"); q.appendChild(el("b", null, "You: ")); q.appendChild(document.createTextNode(h.q)); d.appendChild(q); const a = el("div", "a", h.a); d.appendChild(a); }
    if (hist.length) { const c = btn("ghost small", "Clear these questions", () => { store.set("ask:" + key, []); const nd = askBox(key, title, ctx); d.replaceWith(nd); }); c.style.marginTop = "6px"; d.appendChild(c); }
    const ta = el("textarea"); ta.rows = 2; ta.placeholder = "For example: there's no “Disabled” in that list, only speeds."; d.appendChild(ta);
    const row = el("div", "row"); row.style.cssText = "gap:8px;margin-top:6px;flex-wrap:wrap";
    const out = el("div", "a"); out.hidden = true;
    const ctxText = () => { try { return String(ctx() || "").slice(0, 6000); } catch (e) { return title; } };
    row.appendChild(btn("small", "✨ Ask", async (e) => {
      const q = ta.value.trim(); if (!q) throw new Error("Write what doesn't match, or your question, first.");
      const b = e && e.target; if (b) { b.disabled = true; b.textContent = "Asking…"; }
      try {
        const prompt = "You are helping someone use aGoldenDiagnose, a Windows app that watches PC games and the PC for problems. It found the problem below and suggested what to do. The person has a question, or says something doesn't match what they see. Answer in plain words, briefly, with concrete numbered steps for their exact hardware and settings. If the app's suggestion doesn't fit their setup, say so plainly and give the right step instead. Don't invent settings that aren't listed; if you're unsure, say what to look for.\n\nWhat the app shows:\n" + ctxText()
          + (hist.length ? "\n\nEarlier in this conversation:\n" + hist.slice(-4).map((h) => "Q: " + h.q + "\nA: " + h.a).join("\n") : "") + "\n\nTheir message: " + q;
        const r = window.askAI ? await window.askAI(prompt) : { ok: false, error: "none" };
        if (!r.ok) { out.hidden = false; out.textContent = r.error === "none" ? "No AI is set up yet: Settings → AI (your own Claude key, or a local AI model on this PC). You can still report it with the other button." : r.error; return; }
        const all = (store.get("ask:" + key, []) || []).concat([{ q, a: r.text || "(no answer)", t: Date.now() }]).slice(-12); store.set("ask:" + key, all);
        alog("pc ask: " + title + " | Q: " + q.slice(0, 300));
        const nd = askBox(key, title, ctx); nd.open = true; d.replaceWith(nd);
      } finally { if (b) { b.disabled = false; b.textContent = "✨ Ask"; } }
    }));
    row.appendChild(btn("ghost small", "Report it", async () => {
      const q = ta.value.trim(); if (!q) throw new Error("Write what doesn't match first.");
      if (window.APPCFG && window.APPCFG.share) {
        const what = q + "\n\nWhere: PC tab, “" + title + "”.\n\nWhat the app suggested:\n" + ctxText().slice(0, 2500);
        const u = "https://github.com/SirGoldenTaco/agoldendiagnose-app/issues/new?template=problem.yml&title=" + encodeURIComponent("Advice doesn't fit: " + title.slice(0, 80)) + "&version=" + encodeURIComponent(typeof appVersion === "string" ? appVersion : "") + "&what=" + encodeURIComponent(what);
        await window.native.openUrl(u.slice(0, 7500)); toast("The issue form opened in your browser, filled in. Check it (remove anything personal), then post it.", false, 8000);
      } else { alog("pc issue report: " + title + " | " + q.slice(0, 1000) + " || context: " + ctxText().slice(0, 1500), true); toast("Reported: it's in the app's log, so it can be fixed.", false, 6000); ta.value = ""; }
    }));
    d.appendChild(row); d.appendChild(out);
    return d;
  }
  const netCtx = (i) => () => { const g = i.diag || {}, c = g.card || {}; return [i.title + " (" + new Date(i.at || i.t).toLocaleString() + ")", i.detail || "", ...(g.found || []), c.desc ? "Card: " + c.desc + ", " + (c.speed || "") + ", driver " + (c.driver || "") + " (" + (c.date || "") + ")" : "", ...(g.settings || []).map((x) => "Setting “" + x.n + "” = " + x.v + (x.vals && x.vals.length ? " (choices: " + x.vals.join(", ") + ")" : "")), g.allowOff ? "Allow the computer to turn off this device: " + g.allowOff : "", "Suggested:", ...(g.steps || []).map((st) => st.t + ": " + (st.s || []).join(" "))].filter(Boolean).join("\n"); };

  // "Look into it" / "Look again": reads the network card again (a few seconds), then redraws wherever the drop is
  // shown, the PC tab's list and a tile's page alike, keeping it open
  async function lookInto(i, e) {
    const b = e && e.target; if (b) { b.disabled = true; b.textContent = "Looking… (a few seconds)"; }
    const before = JSON.stringify((i.diag && i.diag.steps) || []);
    const r = await P.pc("netdiag", { id: i.id });
    openInc = i.id; await load();
    if (DET.which) { const d = await P.pc("detail", { which: DET.which }); if (DET.which) { DET.data = d; drawDetail(); } }
    toast(!r ? "It couldn't be looked into." : JSON.stringify(r.steps || []) === before ? "Looked again: same as before." : "Looked again: updated.");
  }
  function netFindings(i, d) {
    if (i.kind !== "net" || i.open) return;
    if (i.diag) {
      if (i.diag.found && i.diag.found.length) { const f = el("div", "found"); f.appendChild(el("div", "lbl2", "What the app found")); for (const x of i.diag.found) f.appendChild(el("p", null, x)); d.appendChild(f); }
      if (i.diag.error) d.appendChild(el("p", "kv", "Part of it couldn't be read: " + i.diag.error));
      if (i.diag.steps && i.diag.steps.length) d.appendChild(stepsBox(i.diag.steps, "What to try"));
      if (i.diag.at) d.appendChild(el("p", "kv", "Looked at " + new Date(i.diag.at).toLocaleString() + "."));
      d.appendChild(btn("ghost small", "Look again", (e) => lookInto(i, e)));
    } else d.appendChild(btn("small", "Look into it", (e) => lookInto(i, e)));
    d.appendChild(askBox("inc:" + i.id, i.title, netCtx(i)));
  }

  function drawIncidents() {
    const box = $("pcInc"), all = PS ? PS.incidents : []; box.textContent = "";
    const list = all.filter((i) => !i.dismissed || i.open), gone = all.filter((i) => i.dismissed && !i.open);
    $("pcIncNone").hidden = list.length > 0; $("pcIncNone").textContent = gone.length ? "Nothing new: " + gone.length + " dismissed below." : "Nothing has gone wrong since the watching started."; $("pcClear").hidden = !all.length;
    if ($("pcDismissAll")) $("pcDismissAll").hidden = list.filter((i) => !i.open).length < 2;
    const drawOne = (i, dismissed, into) => {
      const d = el("details", "inc s-" + i.sev + (i.open ? " open" : "")); d.open = openInc === i.id; d.ontoggle = () => { if (d.open) openInc = i.id; else if (openInc === i.id) openInc = ""; };
      const s = el("summary"); s.appendChild(el("span", "badge b-" + i.sev, i.open ? "Now" : SEV[i.sev][0])); s.appendChild(el("b", null, i.title + (i.count > 1 ? "  ×" + i.count : "")));
      if (!i.open) s.appendChild(dismissBtn(dismissed, () => P.pc("dismiss", { ids: [i.id], on: !dismissed })));
      s.appendChild(el("small", null, new Date(i.at || i.t).toLocaleString() + (i.open ? " · still going on (" + span(Date.now() - i.t) + ")" : i.end ? " · lasted " + span(i.end - i.t) : ""))); d.appendChild(s);
      if (i.detail) d.appendChild(el("p", null, i.detail));
      const facts = [];
      if (i.top && i.top.cpu && i.top.cpu.length) facts.push("Processor: " + i.top.cpu.filter((x) => x.cpu > 0).slice(0, 4).map((x) => x.name + " " + x.cpu + "%").join(", "));
      if (i.top && i.top.mem && i.top.mem.length) facts.push("Memory: " + i.top.mem.slice(0, 4).map((x) => x.name + " " + gb(x.mem)).join(", "));
      if (i.net) facts.push("Internet then: " + ((i.net.pings || []).map((x) => x.host + " " + (x.ms > 0 ? x.ms + " ms" : "no answer")).join(", ")) + (i.net.gatewayMs > 0 ? ", router " + i.net.gatewayMs + " ms" : ", router no answer") + (i.net.adapter ? " (" + i.net.adapter + (i.net.mbps ? ", " + i.net.mbps + " Mbps" : "") + ")" : ""));
      if (i.source) facts.push("From Windows' event log: " + i.source);
      if (facts.length) { const f = el("div", "kv"); f.style.whiteSpace = "pre-wrap"; f.textContent = "At that moment\n" + facts.join("\n"); d.appendChild(f); }
      netFindings(i, d);
      into.appendChild(d);
    };
    for (const i of list.slice(0, 120)) drawOne(i, false, box);
    listSearch(box, "details.inc", "pcInc", "Search what went wrong");
    if (gone.length) {
      const f = el("details", "okbox"); f.open = store.get("pcGoneOpen", false) === true; f.addEventListener("toggle", () => store.set("pcGoneOpen", f.open));
      f.appendChild(el("summary", null, "Dismissed (" + gone.length + ")"));
      for (const i of gone.slice(0, 120)) drawOne(i, true, f);
      listSearch(f, "details.inc", "pcIncGone", "Search dismissed");
      f.appendChild(btn("ghost small", "Bring them all back", async () => { await P.pc("dismiss", { ids: gone.map((i) => i.id), on: false }); await load(); }));
      box.appendChild(f);
    }
  }
  // ✕ on an entry (or "Bring back" on a dismissed one); doesn't open or close the entry it sits on
  function dismissBtn(dismissed, fn) {
    const b = el("button", "ghost small xbtn", dismissed ? "Bring back" : "✕"); b.type = "button"; b.title = dismissed ? "Put it back in the list" : "Dismiss (it moves to Dismissed at the bottom; nothing is deleted)";
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); Promise.resolve(fn()).then(() => load()).then(() => { if (DET.which) return P.pc("detail", { which: DET.which }).then((d) => { if (DET.which) { DET.data = d; drawDetail(); } }); }).catch((x) => toast(x.message || String(x), true)); };
    return b;
  }

  function drawHealth() {
    const h = PS && PS.health, box = $("pcHealth"); box.textContent = "";
    $("pcCheck").textContent = checking ? "Checking…" : h ? "Check my PC again" : "Check my PC";
    $("pcCheck").disabled = checking;
    if ($("pcCheckAdmin")) $("pcCheckAdmin").disabled = checking;
    if (checking) { box.appendChild(el("div", "kv", "Reading Windows' record of the last 30 days, the drives, the memory, the graphics driver and the internet. This takes up to a minute.")); return; }
    if (!h) { box.appendChild(el("div", "kv", "A one-off look at the whole PC: blue screens, sudden shutdowns and hardware errors in Windows' record, drive health and free room, memory, the graphics driver, Windows updates, and the internet connection. Nothing is changed on the PC.")); return; }
    const ig0 = (PS && PS.ignore) || {}, k0 = (it) => it.key || it.area + ":" + String(it.title).replace(/[0-9.,:]+/g, "#").replace(/\s+/g, " ").slice(0, 80);
    const nb = h.items.filter((it) => it.sev === "bad" && !ig0[k0(it)]).length, nw = h.items.filter((it) => it.sev === "warn" && !ig0[k0(it)]).length;
    const v = el("div", "verdict " + (nb ? "is-bad" : nw ? "" : "is-ok")); v.appendChild(el("h3", null, nb ? nb + " problem" + (nb > 1 ? "s" : "") + " found" : nw ? "No serious problem, " + nw + " thing" + (nw > 1 ? "s" : "") + " to look at" : "This PC looks healthy"));
    v.appendChild(el("p", null, "Checked " + ago(h.at) + (h.elevated ? " as administrator" : "") + (h.partial ? ". Part of it couldn't be read (drives, memory modules and Windows details need PowerShell, which didn't answer)." : ".") + " The result is also saved as a text file in the logs folder.")); box.appendChild(v);
    let area = "";
    const ign = (PS && PS.ignore) || {}, keyOf = (it) => it.key || it.area + ":" + String(it.title).replace(/[0-9.,:]+/g, "#").replace(/\s+/g, " ").slice(0, 80);
    const ignore = (it, on) => guard(async () => { PS.ignore = await P.pc("ignore", { key: keyOf(it), title: it.title, on }); drawHealth(); });
    const row = (it, ignored) => {
      const r = el("div", "hrow s-" + it.sev + (ignored ? " ignored" : "")); r.appendChild(el("span", "badge b-" + it.sev, SEV[it.sev][0]));
      const t = el("div", "t"), head = el("div", "row"); head.style.cssText = "gap:8px;align-items:flex-start"; const tb = el("b", "grow", it.title); head.appendChild(tb);
      if (it.sev !== "ok") { const x = btn("ghost small", ignored ? "Unignore" : "Ignore", ignore(it, !ignored)); x.title = ignored ? "Count it again" : "Hide it and leave it out of the count (it comes back with Unignore)"; head.appendChild(x); }
      t.appendChild(head); t.appendChild(el("small", null, it.area)); if (it.text) t.appendChild(el("p", null, it.text));
      const steps = it.steps || (it.tip ? [it.tip] : null);
      if (steps && !ignored) { const dd = el("details", "todo"); dd.open = it.sev === "bad"; dd.appendChild(el("summary", null, "What to do")); dd.appendChild(stepsBox(steps)); t.appendChild(dd); }
      if (!ignored) t.appendChild(askBox("chk:" + keyOf(it), it.title, () => [it.area + ": " + it.title, it.text, "Suggested:", ...(steps || [])].filter(Boolean).join("\n")));
      r.appendChild(t); return r;
    };
    const shown = h.items.filter((it) => it.sev !== "ok" && !ign[keyOf(it)]), hidden = h.items.filter((it) => it.sev !== "ok" && ign[keyOf(it)]);
    for (const it of shown) box.appendChild(row(it, false));
    listSearch(box, ".hrow", "health", "Search the findings");
    if (hidden.length) { const d = el("details", "okbox"); d.appendChild(el("summary", null, hidden.length + " ignored")); for (const it of hidden) d.appendChild(row(it, true)); box.appendChild(d); listSearch(d, ".hrow", "healthIgn", "Search ignored findings"); }
    void area;
  }

  function drawPcSettings() {
    const s = (PS && PS.settings) || {};
    for (const [id, k] of [["pOn", "on"], ["pNet", "net"], ["pNotify", "notify"], ["pKeep", "keepAlive"], ["pAsk", "askQuit"]]) { const c = $(id); if (!c) continue; c.checked = !!s[k]; c.onchange = guard(async () => { await P.pc("settings", { [k]: c.checked }); await load(); }); }
    const chips = (box, key, opts) => { box.textContent = ""; for (const [val, label] of opts) { const b = el("button", s[key] === val ? "on" : "", label); b.type = "button"; b.onclick = guard(async () => { await P.pc("settings", { [key]: val }); await load(); }); box.appendChild(b); } };
    chips($("pRam"), "ramPct", [[85, "85%"], [92, "92%"], [96, "96%"]]); chips($("pGt"), "gpuTemp", [[80, "80 °C"], [87, "87 °C"], [92, "92 °C"]]);
  }

  /* ---------------------------------------------------------------- one tile in detail */
  const DET = { which: "", data: null };
  const DET_NAME = { cpu: "Processor", ram: "Memory", gpu: "Graphics card", net: "Internet", link: "Network" };
  const factGrid = (rows) => { const g = el("div", "facts2"); for (const [k, v] of rows) { if (v === "" || v == null) continue; g.appendChild(el("span", "k", k)); g.appendChild(el("span", "v", String(v))); } return g; };
  const section = (title) => { const c = el("div", "card"); c.style.marginTop = "10px"; c.appendChild(el("div", "sec", title)); c.firstChild.style.marginTop = "0"; return c; };
  function openDetail(which) {
    DET.which = which; DET.data = null; $("pcBody").classList.add("detailing"); drawDetail(); window.scrollTo(0, 0);
    P.pc("detail", { which }).then((d) => { if (DET.which === which) { DET.data = d; drawDetail(); } }).catch(() => {});
  }
  function closeDetail() { DET.which = ""; DET.data = null; $("pcBody").classList.remove("detailing"); $("pcDetail").textContent = ""; }
  window.pcDetailBack = () => { if (!DET.which) return false; closeDetail(); return true; };
  // the part that moves every few seconds: big value, chart and live readings
  function drawDetailLive() {
    const box = document.getElementById("pcDetLive"); if (!box || !LIVE) return;
    const L = LIVE, p = L.pc || {}, n = L.net || {}, T = L.temps || {}, ch = L.chart || {}, w = DET.which; box.textContent = "";
    const main = (p.nets || []).find((x) => x.up && x.gateway) || (p.nets || []).find((x) => x.up);
    const big = { cpu: p.cpu >= 0 ? Math.round(p.cpu) + "%" : "…", ram: p.ramTotal ? Math.round((1 - p.ramFree / p.ramTotal) * 100) + "%" : "…", gpu: p.gpu >= 0 ? Math.round(p.gpu) + "%" : "n/a", net: n.state ? { ok: "Online", cable: "Disconnected", router: "Router silent", down: "No internet", dns: "DNS failing", slow: "Unstable" }[n.state] : "…", link: "↓ " + rate(p.rx || 0) + "   ↑ " + rate(p.tx || 0) }[w];
    box.appendChild(el("div", "detbig", big));
    const cv = el("canvas", "spark big"); box.appendChild(cv);
    const legend = { cpu: "Processor use, last 10 minutes", ram: "Memory in use, last 10 minutes", gpu: "Graphics card use, last 10 minutes", net: "Internet reply time (gaps: no answer), last 20 minutes", link: "Download speed, last 10 minutes" }[w];
    box.appendChild(el("div", "kv", legend));
    const sys = (DET.data && DET.data.sys) || {}, gpuSys = (sys.gpus || []).find((x) => /nvidia|amd|radeon|geforce|arc/i.test(x.name || "")) || (sys.gpus || [])[0] || {};
    const rows = {
      cpu: [["Model", sys.cpu], ["Threads", p.cores], ["Use", p.cpu >= 0 ? p.cpu + "%" : ""], ["Temperature", T.cpu > 0 ? deg(T.cpu) + (T.cpuLabel ? " (" + T.cpuLabel + ")" : "") : "not read (see below)"], ["Motherboard", T.board > 0 ? deg(T.board) + (T.boardLabel ? " (" + T.boardLabel + ")" : "") : ""], ...((T.acpi || []).map((a) => ["ACPI zone", Math.round(a.c) + " °C (the motherboard's own; may not change)"])), ["Programs running", p.procs], ["Windows running for", p.upMs ? span(p.upMs) : ""], ["Motherboard model", sys.board], ["BIOS", sys.bios]],
      ram: [["Installed", p.ramTotal ? gb(p.ramTotal) : ""], ["In use", p.ramTotal ? gb(p.ramTotal - p.ramFree) : ""], ["Free", p.ramFree ? gb(p.ramFree) : ""], ["Committed (memory + page file)", p.commitTotal ? gb(p.commitTotal - p.commitFree) + " of " + gb(p.commitTotal) : ""], ["Page file", sys.pagefileMB > 0 ? gb(sys.pagefileMB * 1048576) : ""], ["Temperature", T.ram > 0 ? deg(T.ram) : "not read (see below)"]],
      gpu: [["Card", (p.gpuName || gpuSys.name || "")], ["Driver", gpuSys.driver ? gpuSys.driver + (gpuSys.driverDate ? " (" + gpuSys.driverDate + ")" : "") : ""], ["Use", p.gpu >= 0 ? Math.round(p.gpu) + "%" : ""], ["Temperature", deg(p.gpuTemp)], ["Video memory", p.vramMB > 0 ? (p.vramMB / 1024).toFixed(1) + (p.vramTotalMB > 0 ? " of " + Math.round(p.vramTotalMB / 1024) : "") + " GB" : ""], ["Power", p.gpuPower > 0 ? Math.round(p.gpuPower) + " W" : ""], ["Fan", p.gpuFan >= 0 ? Math.round(p.gpuFan) + "%" : ""], ["Screen", sys.screen]],
      net: [["State", big], ["1.1.1.1 / 8.8.8.8", (n.pings || []).map((x) => (x.ms > 0 ? x.ms + " ms" : "no answer")).join(" / ")], ["Router", n.gatewayMs > 0 ? n.gatewayMs + " ms" : "no answer"], ["Name server (DNS)", n.dnsMs > 0 ? n.dnsMs + " ms" : n.dns ? "no answer" : ""], ["Answers lost", (n.loss || 0) + "%"], ["Through", n.adapter ? n.adapter + (n.wifi ? " (Wi-Fi)" : " (cable)") + (n.mbps ? ", " + (n.mbps >= 1000 ? n.mbps / 1000 + " Gbps" : n.mbps + " Mbps") : "") : ""]],
      link: [["Card", main ? main.desc || main.name : ""], ["Connection", main ? (main.wifi ? "Wi-Fi" : "Cable") + (main.mbps ? " at " + (main.mbps >= 1000 ? main.mbps / 1000 + " Gbps" : main.mbps + " Mbps") : "") : "none"], ["Download now", rate(p.rx || 0)], ["Upload now", rate(p.tx || 0)], ["This PC's address", main ? main.ip : ""], ["Router", main ? main.gateway : ""]],
    }[w] || [];
    box.appendChild(factGrid(rows));
    if (w === "cpu" || w === "ram") {
      const list = w === "cpu" ? p.topCpu : p.topMem, c = el("div", "topcol"); c.style.marginTop = "10px"; c.appendChild(el("div", "lbl", w === "cpu" ? "Using the processor most" : "Using the most memory"));
      for (const x of (list || []).slice(0, 6)) { const r = el("div", "toprow"); r.appendChild(el("span", "n", x.name)); r.appendChild(el("span", "v", w === "cpu" ? x.cpu + "%" : gb(x.mem))); c.appendChild(r); } box.appendChild(c);
    }
    requestAnimationFrame(() => { if (w === "net") spark(cv, ch.net, 1, 0, "#58a6ff"); else spark(cv, ch.pc, { cpu: 1, ram: 2, gpu: 3, link: 5 }[w], w === "link" ? 0 : 100, { cpu: "#e3b341", ram: "#56d364", gpu: "#d2a8ff", link: "#79c0ff" }[w]); });
  }
  function drawDetail() {
    const box = $("pcDetail"), w = DET.which, d = DET.data, T = (LIVE && LIVE.temps) || {}; box.textContent = ""; if (!w) return;
    const head = el("div", "row"); head.style.cssText = "margin:10px 0;gap:10px;align-items:center"; const bk = btn("ghost", "← Back", () => closeDetail()); bk.setAttribute("data-back", ""); head.appendChild(bk); head.appendChild(el("b", null, DET_NAME[w])); head.lastChild.style.fontSize = "18px"; box.appendChild(head); { const q = quickRow(QUICK_FOR[w] || []); if (q) { q.style.margin = "0 0 10px"; box.appendChild(q); } }
    const live = el("div", "card"); live.id = "pcDetLive"; box.appendChild(live); drawDetailLive();
    // temperatures that need a sensor program (Windows)
    const isWin = !/Linux/.test(navigator.userAgent);
    if (isWin && ((w === "cpu" && !(T.cpu > 0)) || (w === "ram" && !(T.ram > 0)))) {
      const c = section("Temperature"); c.appendChild(el("p", "kv", "Windows has no standard way to read the " + (w === "cpu" ? "processor's" : "memory's") + " temperature without installing a driver, and this app doesn't install one. It can read it from LibreHardwareMonitor, a free, open-source sensor program, while that is running:"));
      c.appendChild(stepsBox(["Download LibreHardwareMonitor from its GitHub page (github.com/LibreHardwareMonitor/LibreHardwareMonitor → Releases) and start it.", "In it: Options → Remote Web Server → Run (it uses port 8085). Options → Run On Windows Startup if you want it always.", "Come back here: the temperature shows up within a minute. aGoldenDiagnose only reads it from this PC (127.0.0.1); nothing leaves the PC."])); box.appendChild(c);
    }
    if (!d) { box.appendChild(el("p", "kv", "Reading Windows' log and the details…")); return; }
    // the network card's settings and the last 7 days (Internet, Network)
    if ((w === "net" || w === "link") && (d.adapter || (d.drops || []).length)) {
      const c = section(w === "net" ? "The last 7 days" : "The network card");
      if (d.adapter && d.adapter.adapter && w === "link") { const a = d.adapter.adapter; c.appendChild(factGrid([["Card", a.desc], ["Linked at", a.speed], ["Driver", a.driver ? a.driver + (a.date ? " (" + String(a.date).split(" ")[0] + ")" : "") : ""], ["Windows may turn it off to save power", d.adapter.allowOff === "Enabled" || d.adapter.allowOff === "True" ? "yes" : d.adapter.allowOff ? "no" : ""], ...((d.adapter.settings || []).map((x) => [x.n, x.v]))])); }
      const drops = (d.drops || []).filter((o) => o.what !== "slow" && o.what !== "dns"), down = drops.reduce((a, o) => a + Math.max(1000, o.end - o.t), 0);
      c.appendChild(el("p", null, drops.length ? drops.length + " drop" + (drops.length > 1 ? "s" : "") + " in the last 7 days, " + span(down) + " without internet in all." + (d.adapter && d.adapter.week ? " The network card itself reported " + (d.adapter.week.down || 0) + " link drop(s) and Windows reset it " + (d.adapter.week.resets || 0) + " time(s)." : "") : "No drops in the last 7 days."));
      c.appendChild(btn("ghost small", "Outage report", () => { closeDetail(); const o = $("pcOut"); o.hidden = false; $("pcOutTo").value = new Date().toISOString().slice(0, 10); if (!$("pcOutFrom").value) $("pcOutFrom").value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); o.scrollIntoView({ block: "center" }); }));
      box.appendChild(c);
    }
    if (w === "cpu" && (T.drives || []).length) { const c = section("Drive temperatures"); c.appendChild(factGrid(T.drives.map((x) => [(x.letters ? x.letters + "  " : "") + (x.model || x.n), x.c + " °C" + (x.warn ? " (warning at " + x.warn + " °C)" : "")]))); box.appendChild(c); }
    // problems the app saw
    if (w === "net" || w === "link") box.appendChild(changesSection(d.changes || [], w));
    const incAll = d.incidents || [], incLive = incAll.filter((i) => !i.dismissed || i.open), incGone = incAll.filter((i) => i.dismissed && !i.open);
    const pc = section("Problems seen (" + incLive.length + ")");
    if (!incLive.length) pc.appendChild(el("p", "kv", incGone.length ? "Nothing new: " + incGone.length + " dismissed below." : "Nothing went wrong with it since the watching started."));
    const incRow = (i, dismissed, into) => { const r = el("details", "inc s-" + i.sev); r.open = openInc === i.id; r.ontoggle = () => { if (r.open) openInc = i.id; }; const sm = el("summary"); sm.appendChild(el("span", "badge b-" + i.sev, SEV[i.sev][0])); sm.appendChild(el("b", null, i.title + (i.count > 1 ? "  ×" + i.count : ""))); if (!i.open) sm.appendChild(dismissBtn(dismissed, () => P.pc("dismiss", { ids: [i.id], on: !dismissed }))); sm.appendChild(el("small", null, new Date(i.at || i.t).toLocaleString())); r.appendChild(sm); if (i.detail) r.appendChild(el("p", null, i.detail)); netFindings(i, r); into.appendChild(r); };
    for (const i of incLive.slice(0, 25)) incRow(i, false, pc);
    listSearch(pc, "details.inc", "detInc", "Search problems");
    if (incLive.filter((i) => !i.open).length > 1) pc.appendChild(btn("ghost small", "Dismiss them all", async () => { await P.pc("dismiss", { ids: incLive.filter((i) => !i.open).map((i) => i.id), on: true }); await load(); const nd = await P.pc("detail", { which: w }); if (DET.which === w) { DET.data = nd; drawDetail(); } }));
    if (incGone.length) { const f = el("details", "okbox"); f.appendChild(el("summary", null, "Dismissed (" + incGone.length + ")")); for (const i of incGone.slice(0, 25)) incRow(i, true, f); listSearch(f, "details.inc", "detIncGone", "Search dismissed"); pc.appendChild(f); }
    box.appendChild(pc);
    // Windows' own log: entries can be dismissed too (remembered on this PC)
    const evKey = (e) => e.t + "|" + e.source, evHid = store.get("evHidden", {}) || {};
    const evAll = d.events || [], evLive = evAll.filter((e) => !evHid[evKey(e)]), evGone = evAll.filter((e) => evHid[evKey(e)]);
    const setEv = (fn) => { const h = Object.assign({}, store.get("evHidden", {}) || {}); fn(h); const keep = Date.now() - 30 * 86400000; for (const k of Object.keys(h)) if (+k.split("|")[0] < keep) delete h[k]; store.set("evHidden", h); drawDetail(); };
    const ev = section("In Windows' log, last 14 days (" + evLive.length + ")");
    if (!evLive.length) ev.appendChild(el("p", "kv", evGone.length ? "Nothing new: " + evGone.length + " dismissed below." : "Windows wrote nothing about it."));
    const evRow = (e, dismissed, into) => { const r = el("div", "hrow s-" + e.sev); r.appendChild(el("span", "badge b-" + e.sev, SEV[e.sev] ? SEV[e.sev][0] : "Note")); const t = el("div", "t"), hd = el("div", "row"); hd.style.cssText = "gap:8px;align-items:flex-start"; const tb = el("b", "grow", e.title); hd.appendChild(tb); hd.appendChild(btn("ghost small", dismissed ? "Bring back" : "✕", () => setEv((h) => { if (dismissed) delete h[evKey(e)]; else h[evKey(e)] = Date.now(); }), dismissed ? "Put it back in the list" : "Dismiss (it moves to Dismissed below)")); t.appendChild(hd); t.appendChild(el("small", null, new Date(e.t).toLocaleString() + " · " + e.source)); if (e.text) t.appendChild(el("p", null, e.text)); r.appendChild(t); into.appendChild(r); };
    for (const e of evLive.slice(0, 20)) evRow(e, false, ev);
    listSearch(ev, ".hrow", "detEv", "Search Windows' log");
    if (evLive.length > 1) ev.appendChild(btn("ghost small", "Dismiss them all", () => setEv((h) => { for (const e of evLive) h[evKey(e)] = Date.now(); })));
    if (evGone.length) { const f = el("details", "okbox"); f.appendChild(el("summary", null, "Dismissed (" + evGone.length + ")")); for (const e of evGone.slice(0, 20)) evRow(e, true, f); listSearch(f, ".hrow", "detEvGone", "Search dismissed"); f.appendChild(btn("ghost small", "Bring them all back", () => setEv((h) => { for (const e of evGone) delete h[evKey(e)]; }))); ev.appendChild(f); }
    box.appendChild(ev);
    // what you can do
    const tips = {
      cpu: ["High use with no game open: open “Using the processor most” above; a program you don't recognise using a lot for a long time is worth a look.", "Temperatures: under 85 °C in games is comfortable; near 95 °C (89 °C for some X3D chips) the processor slows itself down. Check the cooler, its fans and the dust.", "Stutter with low use: often one core is full; that's the game, not the PC."],
      ram: ["Over 90% in use while playing makes Windows move things to the page file: stutter. Close browsers and launchers you don't need.", "Committed near its limit means the page file is too small or the drive holding it is full: keep it on “Automatically manage”.", "Memory errors (blue screens, programs crashing everywhere): test with Windows Memory Diagnostic or MemTest86, and try without the memory profile (XMP/EXPO)."],
      gpu: ["Over 85 °C: clean the fans, check case airflow, or cap the frame rate.", "“The graphics driver stopped and recovered”: reinstall the driver as a clean install and remove overclocks/undervolts.", "Video memory full: lower texture quality; it causes stutter more than low frame rates."],
      net: ["Open any drop under What went wrong: the app looks into the network card at that moment and lists what to try.", "Drops where the router still answered are past your home network: the modem or the provider. The outage report is what to send them.", "High reply time with the router fast: congestion at the provider or someone downloading at home."],
      link: ["Short drops on a cable: turn off the card's power saving (Energy-Efficient Ethernet, Green Ethernet) and update its driver; both are listed above when the app can read them.", "A multi-gig link (2.5/5/10 Gbps) needs Cat 6 or better cable; an old cable can drop in and out.", "Linked at only 100 Mbps: the cable or a plug is worn."],
    }[w];
    if (tips) { const c = section("What you can do"); c.appendChild(stepsBox(tips)); box.appendChild(c); }
    { const c = section("Ask about it"); c.appendChild(askBox("det:" + w, DET_NAME[w], () => DET_NAME[w] + " page\n" + (($("pcDetLive") || {}).innerText || "").slice(0, 2500) + "\nProblems seen: " + (d.incidents || []).slice(0, 8).map((i) => i.title).join("; ") + "\nTips shown: " + (tips || []).join(" "))); c.lastChild.open = true; box.appendChild(c); }
  }

  async function load() { if (!P) return; PS = await P.pc("state"); if (!PS) return; LIVE = PS.live; drawLive(); drawIncidents(); drawHealth(); drawPcSettings(); const n = (PS.incidents || []).filter((i) => i.open).length, tb = document.querySelector('#tabs button[data-tab="pc"]'); if (tb) tb.textContent = n ? "PC (" + n + ")" : "PC"; }
  window.pcShown = () => { load(); };

  if (!P) { const o = $("pcOff"); if (o) { o.hidden = false; o.textContent = "The PC tab works in the Windows app."; } $("pcBody").hidden = true; return; }
  const runCheck = (admin) => guard(async () => { checking = true; drawHealth(); try { const r = await P.pc("check", admin ? { admin: true } : undefined); if (PS) PS.health = r; } finally { checking = false; await load(); } });
  $("pcCheck").onclick = runCheck(false);
  if ($("pcCheckAdmin")) $("pcCheckAdmin").onclick = runCheck(true);
  // the outage report: every drop between two dates, worded for the internet provider
  const day = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  const clock = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); };
  const OUT_WHAT = { blip: null, down: "Internet past the router (the router still answered)", router: "The router stopped answering", cable: "This PC's own connection (cable or Wi-Fi)", dns: "Names didn't resolve (the provider's DNS)", slow: "Unstable: answers lost or very slow" };
  function outageText(list, from, to, changes) {
    const drops = list.filter((o) => o.what !== "slow" && o.what !== "dns"), shaky = list.filter((o) => o.what === "slow" || o.what === "dns");
    const len = (o) => Math.max(1000, o.end - o.t), sum = (a) => a.reduce((n, o) => n + len(o), 0);
    const prov = drops.filter((o) => o.what === "down"), unk = drops.filter((o) => o.what === "blip"), mine = drops.filter((o) => o.what === "cable" || o.what === "router");
    const L = ["INTERNET OUTAGE REPORT", "", "Period: " + day(from) + " to " + day(to - 1),
      "Recorded by aGoldenDiagnose, which checks the connection every 10 seconds: the router, and two internet addresses (1.1.1.1 and 8.8.8.8). Times are local (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ").", "",
      "SUMMARY", "Drops: " + drops.length + (drops.length ? ", down " + span(sum(drops)) + " in all, longest " + span(Math.max(...drops.map(len))) + " (" + day(drops.reduce((a, b) => (len(b) > len(a) ? b : a)).t) + ")" : "")];
    if (drops.length) {
      L.push("  Past the router (the modem or the provider): " + prov.length + (prov.length ? ", " + span(sum(prov)) : ""));
      if (mine.length) L.push("  On this side (this PC's connection or the router): " + mine.length + ", " + span(sum(mine)));
      if (unk.length) L.push("  Short drops from before the app noted which part was down: " + unk.length);
      const byDay = {}; for (const o of drops) byDay[day(o.t)] = (byDay[day(o.t)] || 0) + 1;
      const worst = Object.entries(byDay).sort((a, b) => b[1] - a[1]).slice(0, 3);
      L.push("  Days with the most drops: " + worst.map(([d, n]) => d + " (" + n + ")").join(", "));
    }
    if (shaky.length) L.push("Unstable stretches (lost or very slow answers, or names not resolving): " + shaky.length + ", " + span(sum(shaky)) + " in all");
    L.push("");
    if (!list.length) L.push("No drops and nothing unstable were recorded in this period.");
    else {
      L.push("EVERY EVENT", "Date        Start     End       Length    What was down");
      for (const o of list) L.push(day(o.t) + "  " + clock(o.t) + "  " + (o.open ? "ongoing " : clock(o.end)) + "  " + span(len(o)).padEnd(8) + "  " + (OUT_WHAT[o.what] || (o.what === "blip" ? "Internet (short drop; which part wasn't noted)" : o.what)));
    }
    if (changes && changes.length) { L.push("", "CHANGES MADE (and drops per day in the 7 days before / since)"); for (const c of changes.slice().reverse()) { const st = c.stats || {}; L.push(day(c.t) + "  " + clock(c.t) + "  " + c.text + (c.undone ? " (later undone)" : "") + "  [before " + (st.perDayBefore || 0).toFixed(1) + "/day, after " + (st.perDayAfter == null ? "too soon" : st.perDayAfter.toFixed(1) + "/day") + "]"); } }
    if (prov.length) L.push("", "In " + prov.length + " of these drops the router kept answering while the internet past it didn't, so the problem was between the modem and the provider, not inside the home network.");
    return L.join("\n");
  }
  let OUT_NAME = "";
  $("pcOutBtn").onclick = () => { const o = $("pcOut"); o.hidden = !o.hidden; if (!o.hidden && !$("pcOutFrom").value) { $("pcOutTo").value = day(Date.now()); $("pcOutFrom").value = day(Date.now() - 30 * 86400000); } };
  $("pcOutMake").onclick = guard(async () => {
    const f = $("pcOutFrom").value, t = $("pcOutTo").value; if (!f || !t) throw new Error("Pick both dates.");
    const from = new Date(f + "T00:00:00").getTime(), to = new Date(t + "T00:00:00").getTime() + 86400000;
    if (to <= from) throw new Error("The second date is before the first.");
    const list = (await P.pc("outages", { from, to })) || [], changes = (await P.pc("outchanges", { from, to })) || [];
    $("pcOutText").textContent = outageText(list, from, to, changes); $("pcOutText").hidden = false; $("pcOutActs").hidden = false; OUT_NAME = f + " to " + t;
  });
  $("pcOutCopy").onclick = guard(async () => { await window.native.copyText($("pcOutText").textContent); toast("Report copied. Paste it in an e-mail or a chat with your provider."); });
  $("pcOutSave").onclick = guard(async () => { const r = await P.pc("outagesave", { text: $("pcOutText").textContent, name: OUT_NAME }); if (!r || !r.ok) throw new Error((r && r.error) || "It couldn't be saved."); toast("Saved in your Downloads folder, under aGoldenDiagnose."); });
  $("pcFolder").onclick = () => P.pc("folder");
  $("pcClear").onclick = guard(async () => { await P.pc("clear"); await load(); });
  $("pcDismissAll").onclick = guard(async () => { await P.pc("dismiss", { ids: ((PS && PS.incidents) || []).filter((i) => !i.open && !i.dismissed).map((i) => i.id), on: true }); await load(); toast("Dismissed. They wait under Dismissed at the bottom."); });
  $("pcTurnOn").onclick = guard(async () => { await P.pc("settings", { on: true }); await load(); });
  P.on("pc-live", (l) => { LIVE = l; drawLive(); });
  P.on("pc-update", () => load());
  P.on("pc-open", (id) => { openInc = id; if (window.show) window.show("pc"); load(); });
  addEventListener("resize", () => drawLive());
  load();
})();
