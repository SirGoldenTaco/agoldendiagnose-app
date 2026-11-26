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
  function tile(id, label) {
    let t = document.getElementById(id); if (t) return t;
    t = el("div", "pctile"); t.id = id; t.appendChild(el("div", "lbl", label)); t.appendChild(el("div", "big")); t.appendChild(el("div", "sub")); const c = el("canvas", "spark"); t.appendChild(c); $("pcTiles").appendChild(t); return t;
  }
  function setTile(id, label, big, sub, cls) { const t = tile(id, label); t.children[1].textContent = big; t.children[2].textContent = sub || ""; t.className = "pctile" + (cls ? " " + cls : ""); return t.children[3]; }

  function drawLive() {
    const L = LIVE; if (!L || $("tab-pc").hidden) return;
    const p = L.pc, n = L.net, ch = L.chart || {};
    $("pcOff").hidden = !!L.on; $("pcBody").hidden = !L.on;
    if (!L.on) return;
    // The tiles are always there (so the tab never looks empty); they read "…" until the first measurement arrives.
    const ram = p && p.ramTotal ? (1 - p.ramFree / p.ramTotal) * 100 : -1;
    spark(setTile("tCpu", "Processor", p && p.cpu >= 0 ? Math.round(p.cpu) + "%" : "…", p ? (p.cores ? p.cores + " threads" : "") + (p.procs ? (p.cores ? " · " : "") + p.procs + " programs" : "") : "reading…", p && p.cpu >= 96 ? "warn" : ""), ch.pc, 1, 100, "#e3b341");
    spark(setTile("tRam", "Memory", ram >= 0 ? Math.round(ram) + "%" : "…", p && p.ramTotal ? gb(p.ramTotal - p.ramFree) + " of " + gb(p.ramTotal) : "reading…", ram >= 92 ? "warn" : ""), ch.pc, 2, 100, "#56d364");
    const gt = p && p.gpuTemp > 0 ? Math.round(p.gpuTemp) + " °C" : "", vram = p && p.vramMB > 0 ? (p.vramMB / 1024).toFixed(1) + (p.vramTotalMB > 0 ? " of " + Math.round(p.vramTotalMB / 1024) : "") + " GB video memory" : "";
    const gsub = p ? [(p.gpuName || "").replace(/^NVIDIA\s+/i, ""), gt, vram, p.gpuPower > 0 ? Math.round(p.gpuPower) + " W" : "", p.gpuFan >= 0 ? "fan " + Math.round(p.gpuFan) + "%" : ""].filter(Boolean).join(" · ") : "reading…";
    spark(setTile("tGpu", "Graphics card", p ? (p.gpu >= 0 ? Math.round(p.gpu) + "%" : "n/a") : "…", gsub || "no reading from this card", p && p.gpuTemp >= 87 ? "warn" : ""), ch.pc, 3, 100, "#d2a8ff");
    if (!L.netOn) setTile("tNet", "Internet", "Not watched", "Turn it on in Settings");
    else if (n) {
      const st = n.state || "ok", name = { ok: "Online", cable: "Disconnected", router: "Router silent", down: "No internet", dns: "DNS failing", slow: "Unstable" }[st];
      const sub = [n.best > 0 ? "internet " + n.best + " ms" : "internet: no answer", n.gatewayMs > 0 ? "router " + n.gatewayMs + " ms" : "", n.loss ? n.loss + "% lost" : ""].filter(Boolean).join(" · ");
      spark(setTile("tNet", "Internet", name, sub, st === "ok" ? "good" : st === "slow" || st === "dns" ? "warn" : "bad"), ch.net, 1, 0, "#58a6ff");
    } else setTile("tNet", "Internet", "…", "checking…");
    // what is going through the network card right now
    const main = p ? (p.nets || []).find((x) => x.up && x.gateway) || (p.nets || []).find((x) => x.up) : null;
    spark(setTile("tLink", "Network", p ? "↓ " + rate(p.rx || 0) : "…", p ? "↑ " + rate(p.tx || 0) + (main ? " · " + (main.wifi ? "Wi-Fi" : "cable") + (main.mbps ? " " + (main.mbps >= 1000 ? main.mbps / 1000 + " Gbps" : main.mbps + " Mbps") : "") : " · no connection") : "reading…", main && !main.wifi && main.mbps > 0 && main.mbps <= 100 ? "warn" : ""), ch.pc, 5, 0, "#79c0ff");
    // drives and "right now": filled from the live reading, or a short note while there isn't one yet
    const drives = $("pcDrives"), tp = $("pcTop");
    if (p && (p.drives || p.topCpu)) {
      drives.textContent = "";
      for (const d of p.drives || []) { const used = d.total ? 1 - d.free / d.total : 0, r = el("div", "drv" + (used > 0.95 ? " bad" : used > 0.88 ? " warn" : "")); r.appendChild(el("b", null, d.name + (d.label ? "  " + d.label : ""))); const bar = el("div", "bar"), fill = el("i"); fill.style.width = Math.round(used * 100) + "%"; bar.appendChild(fill); r.appendChild(bar); r.appendChild(el("small", null, gb(d.free) + " free of " + gb(d.total))); drives.appendChild(r); }
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

  function drawIncidents() {
    const box = $("pcInc"), list = PS ? PS.incidents : []; box.textContent = "";
    $("pcIncNone").hidden = list.length > 0; $("pcClear").hidden = !list.length;
    for (const i of list.slice(0, 120)) {
      const d = el("details", "inc s-" + i.sev + (i.open ? " open" : "")); d.open = openInc === i.id; d.ontoggle = () => { if (d.open) openInc = i.id; else if (openInc === i.id) openInc = ""; };
      const s = el("summary"); s.appendChild(el("span", "badge b-" + i.sev, i.open ? "Now" : SEV[i.sev][0])); s.appendChild(el("b", null, i.title + (i.count > 1 ? "  ×" + i.count : "")));
      s.appendChild(el("small", null, new Date(i.at || i.t).toLocaleString() + (i.open ? " · still going on (" + span(Date.now() - i.t) + ")" : i.end ? " · lasted " + span(i.end - i.t) : ""))); d.appendChild(s);
      if (i.detail) d.appendChild(el("p", null, i.detail));
      const facts = [];
      if (i.top && i.top.cpu && i.top.cpu.length) facts.push("Processor: " + i.top.cpu.filter((x) => x.cpu > 0).slice(0, 4).map((x) => x.name + " " + x.cpu + "%").join(", "));
      if (i.top && i.top.mem && i.top.mem.length) facts.push("Memory: " + i.top.mem.slice(0, 4).map((x) => x.name + " " + gb(x.mem)).join(", "));
      if (i.net) facts.push("Internet then: " + ((i.net.pings || []).map((x) => x.host + " " + (x.ms > 0 ? x.ms + " ms" : "no answer")).join(", ")) + (i.net.gatewayMs > 0 ? ", router " + i.net.gatewayMs + " ms" : ", router no answer") + (i.net.adapter ? " (" + i.net.adapter + (i.net.mbps ? ", " + i.net.mbps + " Mbps" : "") + ")" : ""));
      if (i.source) facts.push("From Windows' event log: " + i.source);
      if (facts.length) { const f = el("div", "kv"); f.style.whiteSpace = "pre-wrap"; f.textContent = "At that moment\n" + facts.join("\n"); d.appendChild(f); }
      box.appendChild(d);
    }
  }

  function drawHealth() {
    const h = PS && PS.health, box = $("pcHealth"); box.textContent = "";
    $("pcCheck").textContent = checking ? "Checking…" : h ? "Check my PC again" : "Check my PC";
    $("pcCheck").disabled = checking;
    if ($("pcCheckAdmin")) $("pcCheckAdmin").disabled = checking;
    if (checking) { box.appendChild(el("div", "kv", "Reading Windows' record of the last 30 days, the drives, the memory, the graphics driver and the internet. This takes up to a minute.")); return; }
    if (!h) { box.appendChild(el("div", "kv", "A one-off look at the whole PC: blue screens, sudden shutdowns and hardware errors in Windows' record, drive health and free room, memory, the graphics driver, Windows updates, and the internet connection. Nothing is changed on the PC.")); return; }
    const v = el("div", "verdict " + (h.bad ? "is-bad" : h.warn ? "" : "is-ok")); v.appendChild(el("h3", null, h.bad ? h.bad + " problem" + (h.bad > 1 ? "s" : "") + " found" : h.warn ? "No serious problem, " + h.warn + " thing" + (h.warn > 1 ? "s" : "") + " to look at" : "This PC looks healthy"));
    v.appendChild(el("p", null, "Checked " + ago(h.at) + (h.elevated ? " as administrator" : "") + (h.partial ? ". Part of it couldn't be read (drives, memory modules and Windows details need PowerShell, which didn't answer)." : ".") + " The result is also saved as a text file in the logs folder.")); box.appendChild(v);
    let area = "";
    for (const it of h.items) {
      if (it.sev === "ok") continue;
      const r = el("div", "hrow s-" + it.sev); r.appendChild(el("span", "badge b-" + it.sev, SEV[it.sev][0])); const t = el("div", "t"); t.appendChild(el("b", null, it.title)); t.appendChild(el("small", null, it.area)); if (it.text) t.appendChild(el("p", null, it.text)); if (it.tip) { const tip = el("p", "tip", it.tip); t.appendChild(tip); } r.appendChild(t); box.appendChild(r);
    }
    const oks = h.items.filter((x) => x.sev === "ok"); if (oks.length) { const d = el("details", "okbox"); d.appendChild(el("summary", null, oks.length + " thing" + (oks.length > 1 ? "s" : "") + " checked and fine")); for (const it of oks) { const r = el("div", "hrow s-ok"); r.appendChild(el("span", "badge b-ok", "OK")); const t = el("div", "t"); t.appendChild(el("b", null, it.title)); t.appendChild(el("small", null, it.area)); if (it.text) t.appendChild(el("p", null, it.text)); r.appendChild(t); d.appendChild(r); } box.appendChild(d); }
    void area;
  }

  function drawPcSettings() {
    const s = (PS && PS.settings) || {};
    for (const [id, k] of [["pOn", "on"], ["pNet", "net"], ["pNotify", "notify"], ["pKeep", "keepAlive"], ["pAsk", "askQuit"]]) { const c = $(id); if (!c) continue; c.checked = !!s[k]; c.onchange = guard(async () => { await P.pc("settings", { [k]: c.checked }); await load(); }); }
    const chips = (box, key, opts) => { box.textContent = ""; for (const [val, label] of opts) { const b = el("button", s[key] === val ? "on" : "", label); b.type = "button"; b.onclick = guard(async () => { await P.pc("settings", { [key]: val }); await load(); }); box.appendChild(b); } };
    chips($("pRam"), "ramPct", [[85, "85%"], [92, "92%"], [96, "96%"]]); chips($("pGt"), "gpuTemp", [[80, "80 °C"], [87, "87 °C"], [92, "92 °C"]]);
  }

  async function load() { if (!P) return; PS = await P.pc("state"); if (!PS) return; LIVE = PS.live; drawLive(); drawIncidents(); drawHealth(); drawPcSettings(); const n = (PS.incidents || []).filter((i) => i.open).length, tb = document.querySelector('#tabs button[data-tab="pc"]'); if (tb) tb.textContent = n ? "PC (" + n + ")" : "PC"; }
  window.pcShown = () => { load(); };

  if (!P) { const o = $("pcOff"); if (o) { o.hidden = false; o.textContent = "The PC tab works in the Windows app."; } $("pcBody").hidden = true; return; }
  const runCheck = (admin) => guard(async () => { checking = true; drawHealth(); try { const r = await P.pc("check", admin ? { admin: true } : undefined); if (PS) PS.health = r; } finally { checking = false; await load(); } });
  $("pcCheck").onclick = runCheck(false);
  if ($("pcCheckAdmin")) $("pcCheckAdmin").onclick = runCheck(true);
  $("pcFolder").onclick = () => P.pc("folder");
  $("pcClear").onclick = guard(async () => { await P.pc("clear"); await load(); });
  $("pcTurnOn").onclick = guard(async () => { await P.pc("settings", { on: true }); await load(); });
  P.on("pc-live", (l) => { LIVE = l; drawLive(); });
  P.on("pc-update", () => load());
  P.on("pc-open", (id) => { openInc = id; if (window.show) window.show("pc"); load(); });
  addEventListener("resize", () => drawLive());
  load();
})();
