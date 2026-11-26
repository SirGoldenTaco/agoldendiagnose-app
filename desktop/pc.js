/* aGoldenDiagnose: watching the PC itself (the PC tab).
 *
 * Every few seconds the helper is asked how the PC is doing (processor, memory, graphics card, drives, network cards),
 * whether the internet answers (the router, two addresses on the internet, the name server), and what Windows wrote in
 * its event log. When something is wrong an INCIDENT is written down: what happened, when, for how long, what the PC
 * looked like at that moment (the readings of the minutes before, the programs using the most). Incidents are kept in
 *
 *   %APPDATA%\aGoldenDiagnose\pc-incidents.json            the list the PC tab shows
 *   Documents\aGoldenDiagnose\_PC\log\<date>.log           the same, one readable line per event, a file per day
 *   Documents\aGoldenDiagnose\_PC\check <date time>.txt    each "Check my PC" result
 *
 * Also here: "keep alive" (the app comes back by itself when it is ended any other way than its own Quit).
 */
const { app, ipcMain, shell, Notification, dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const AUTOSTART = require("./autostart");
const LINUX = process.platform === "linux";
const { linuxWords } = require(path.join(__dirname, "web", "analyze.js"));          // the same sentences, said the Linux way

let X = null;                    // what watch.js hands over: ask, tell, alog, cfg(), save(), helperOk(), games(), DATA
const DEF = { on: false, net: false, notify: false, keepAlive: false, askQuit: false, ramPct: 92, gpuTemp: 87 };
const S = () => { const c = X.cfg(); c.pc = Object.assign({}, DEF, c.pc || {}); return c.pc; };
const FILE = () => path.join(app.getPath("userData"), "pc-incidents.json");
const LOGDIR = () => path.join(X.DATA, "_PC", "log");
const z = (n) => String(n).padStart(2, "0");
const dayOf = (t) => { const d = new Date(t); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); };
const timeOf = (t) => { const d = new Date(t); return z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds()); };
const GB = (b) => (b / 1073741824).toFixed(b < 10737418240 ? 1 : 0) + " GB";
const span = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : (s / 3600).toFixed(1) + " h"; };

/* ---------------------------------------------------------------- what is kept */
let DB = { incidents: [], lastEv: 0, daily: {}, health: null };
function load() { try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE(), "utf8"))); } catch {} if (!Array.isArray(DB.incidents)) DB.incidents = []; if (!DB.daily) DB.daily = {}; }
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(DB)); } catch {} }, 400); }
function logLine(t, text) { try { fs.mkdirSync(LOGDIR(), { recursive: true }); fs.appendFileSync(path.join(LOGDIR(), dayOf(t) + ".log"), timeOf(t) + "  " + String(text).replace(/\s*\n\s*/g, " | ") + "\r\n"); } catch {} }

let netBlip = null;                // a drop in progress that hasn't been written down yet
const pcS = [], netS = [];        // the last readings: PC every 5 s (15 min), internet every 10 s (30 min)
let cur = { pc: null, net: null, rate: { rx: 0, tx: 0 } }, lastNote = 0;

/** A new incident (or one more of the same that just happened). sev: "bad" | "warn" | "info". */
function incident(kind, sev, title, detail, extra) {
  if (LINUX) { title = linuxWords(title); detail = linuxWords(detail); }
  if (extra && extra.open && openOf(kind)) return openOf(kind);          // still going on: not a second one
  const now = Date.now(), same = DB.incidents.find((i) => i.kind === kind && i.title === title && now - (i.last || i.t) < 120000 && !i.open);
  if (same) { same.count = (same.count || 1) + 1; same.last = now; save(); X.tell("pc-update"); return same; }
  const i = Object.assign({ id: now.toString(36) + Math.random().toString(36).slice(2, 6), t: now, kind, sev, title, detail: detail || "", count: 1 }, extra || {});
  // what the PC looked like: the two minutes before, and who was using the most
  i.before = pcS.slice(-24).map((s) => [s.t, s.cpu, s.ram, s.gpu, s.gt]);
  if (cur.pc) { i.top = { cpu: (cur.pc.topCpu || []).slice(0, 5).map((p) => ({ name: p.name, cpu: p.cpu })), mem: (cur.pc.topMem || []).slice(0, 5).map((p) => ({ name: p.name, mem: p.mem })) }; }
  i.net = cur.net ? { gatewayMs: cur.net.gatewayMs, pings: cur.net.pings, dnsMs: cur.net.dnsMs, adapter: cur.net.adapter, mbps: cur.net.mbps } : null;
  DB.incidents.unshift(i); if (DB.incidents.length > 400) DB.incidents.length = 400;
  save(); logLine(now, (sev === "bad" ? "PROBLEM  " : sev === "warn" ? "WARNING  " : "NOTE     ") + title + (detail ? " | " + detail : ""));
  X.alog("pc: " + sev + " · " + title + (detail ? " · " + String(detail).slice(0, 300) : ""));
  if (S().notify && sev !== "info" && Notification.isSupported() && now - lastNote > 20000) {
    lastNote = now;
    try { const n = new Notification({ title: "aGoldenDiagnose: " + title, body: String(detail || "").slice(0, 180), silent: sev !== "bad" }); n.on("click", () => X.tell("pc-open", i.id)); n.show(); } catch {}
  }
  X.tell("pc-update"); return i;
}
function closeIncident(i, note) { if (!i || !i.open) return; i.open = false; i.end = Date.now(); if (note) i.detail += (i.detail ? " " : "") + note; save(); logLine(i.end, "OVER     " + i.title + " | lasted " + span(i.end - i.t)); X.alog("pc: over · " + i.title + " · lasted " + span(i.end - i.t)); X.tell("pc-update"); }
const openOf = (kind) => DB.incidents.find((i) => i.open && i.kind === kind);

/* ---------------------------------------------------------------- the PC: readings and what counts as wrong */
const hold = {};                 // how long a condition has been true, so a short spike isn't an incident
function held(key, on, need) { hold[key] = on ? (hold[key] || 0) + 1 : 0; return hold[key] === need; }
function calm(key, on, need) { const k = key + ":calm"; hold[k] = on ? (hold[k] || 0) + 1 : 0; return hold[k] >= need; }
let pcN = 0, lastMbps = 0;
async function pcTick() {
  if (!S().on || !X.helperOk()) return;
  const r = await X.ask("pc", { top: pcN++ % 3 === 0 || Object.keys(hold).some((k) => hold[k] > 0 && !k.endsWith(":calm")) ? 1 : 0 }, 8000);
  if (!r || !r.ok || !r.pc) { if (!pcTick.bad) { pcTick.bad = true; X.alog("pc readings: the watcher returned no reading (" + ((r && r.error) || (r && r.ok ? "no pc field" : "no answer")) + ")"); } return; }
  if (pcTick.bad) { pcTick.bad = false; X.alog("pc readings: working again"); }
  const p = r.pc, prev = cur.pc;
  if (!p.topCpu && prev) { p.topCpu = prev.topCpu; p.topMem = prev.topMem; p.procs = prev.procs; }
  if (prev && p.t > prev.t && p.rx >= prev.rx && p.tx >= prev.tx) { const dt = (p.t - prev.t) / 1000; cur.rate = { rx: (p.rx - prev.rx) / dt, tx: (p.tx - prev.tx) / dt }; }
  cur.pc = p;
  const ram = p.ramTotal ? Math.round((1 - p.ramFree / p.ramTotal) * 1000) / 10 : -1, commit = p.commitTotal ? Math.round((1 - p.commitFree / p.commitTotal) * 1000) / 10 : -1;
  pcS.push({ t: p.t, cpu: p.cpu, ram, gpu: p.gpu, gt: p.gpuTemp, vram: p.vramMB, rx: cur.rate.rx, tx: cur.rate.tx }); if (pcS.length > 180) pcS.shift();
  const s = S(), topM = () => (p.topMem || []).slice(0, 4).map((x) => x.name + " " + GB(x.mem)).join(", "), topC = () => (p.topCpu || []).slice(0, 4).map((x) => x.name + " " + x.cpu + "%").join(", ");

  if (held("ram", ram >= s.ramPct, 12)) incident("ram", "warn", "Memory is almost full (" + Math.round(ram) + "%)", "For a minute now. Using the most: " + topM() + ". When memory runs out, games stutter and programs close by themselves.", { open: true });
  if (openOf("ram") && calm("ram", ram >= 0 && ram < s.ramPct - 6, 12)) closeIncident(openOf("ram"));
  if (held("commit", commit >= 96, 6)) incident("commit", "bad", "Windows is about to run out of memory (" + Math.round(commit) + "% of what it can promise)", "Memory plus the page file is nearly all promised to programs. The next program that asks for more will fail or crash. Using the most: " + topM() + ".", { open: true });
  if (openOf("commit") && calm("commit", commit >= 0 && commit < 88, 12)) closeIncident(openOf("commit"));
  if (held("cpu", p.cpu >= 96, 36)) incident("cpu", "warn", "The processor has been at 100% for 3 minutes", "Using the most: " + topC() + ".", { open: true });
  if (openOf("cpu") && calm("cpu", p.cpu >= 0 && p.cpu < 80, 12)) closeIncident(openOf("cpu"));
  if (held("gt", p.gpuTemp >= s.gpuTemp, 6)) incident("gputemp", p.gpuTemp >= 95 ? "bad" : "warn", "The graphics card is very hot (" + Math.round(p.gpuTemp) + " °C)", "Above " + s.gpuTemp + " °C for 30 seconds. Check that its fans spin and that the case gets fresh air; dust is the usual cause.", { open: true });
  if (openOf("gputemp") && calm("gt", p.gpuTemp >= 0 && p.gpuTemp < s.gpuTemp - 8, 12)) closeIncident(openOf("gputemp"));

  // drives: nearly full (once a day per drive)
  for (const d of p.drives || []) {
    const pct = d.total ? d.free / d.total : 1, sys = /^c:/i.test(d.name), low = sys ? d.free < 12 * 1073741824 || pct < 0.05 : pct < 0.03;
    const key = "disk:" + d.name;
    if (low && DB.daily[key] !== dayOf(Date.now())) { DB.daily[key] = dayOf(Date.now()); incident("disk", sys && d.free < 4 * 1073741824 ? "bad" : "warn", "Drive " + d.name + " is almost full (" + GB(d.free) + " left)", sys ? "Windows needs free room on its own drive for updates, the page file and game shader caches. Below a few GB, programs start failing in odd ways." : "Games installed there can fail to update or save."); }
  }
  // the network card dropping to a slower link (a tired cable or port: 1000 -> 100 Mbps)
  const main = (p.nets || []).find((n) => n.up && n.gateway);
  if (main && !main.wifi) { if (lastMbps >= 1000 && main.mbps > 0 && main.mbps <= 100) incident("linkspeed", "warn", "The network cable dropped to " + main.mbps + " Mbps (it was " + lastMbps + ")", "The card \"" + main.name + "\" renegotiated a slower speed. That is nearly always the cable or one of its plugs: reseat it at both ends, then try another cable or router port."); if (main.mbps > 0) lastMbps = main.mbps; }
  X.tell("pc-live", live());
}

/* ---------------------------------------------------------------- the internet */
const NET_HOSTS = ["1.1.1.1", "8.8.8.8"];
let netState = "ok", netWant = "ok", netWantN = 0, gwEver = false, netChanged = 0;
const NET_TEXT = {
  cable: ["bad", "The network is disconnected", "No network card has a connection: the cable is unplugged, the Wi-Fi dropped, or the router is off."],
  router: ["bad", "The router isn't answering", "The PC is connected, but the router doesn't answer and neither does the internet. Restart the router; if only this PC has the problem, the cable or its network card is the suspect."],
  down: ["bad", "No internet", "The router answers, the internet doesn't. The problem is past your router: the modem or your provider. Restarting the modem is the first thing to try."],
  dns: ["warn", "Names don't resolve (DNS isn't answering)", "The internet answers by address but the name server doesn't, so websites and game servers can't be found by name. Restart the router, or set the PC's DNS to 1.1.1.1 / 8.8.8.8."],
  slow: ["warn", "The connection is unstable", "Answers from the internet are slow or get lost. In games this is lag and rubber-banding."],
};
async function netTick() {
  if (!S().net || !S().on || !X.helperOk()) return;
  const r = await X.ask("net", { hosts: NET_HOSTS, name: "example.com" }, 6000);
  if (!r || !r.ok || !r.net || !Array.isArray(r.net.pings)) { if (!netTick.bad) { netTick.bad = true; X.alog("internet readings: the watcher returned no reading (" + ((r && r.error) || "no answer") + ")"); } return; }
  if (netTick.bad) { netTick.bad = false; X.alog("internet readings: working again"); }
  const n = r.net, ok = n.pings.filter((x) => x.ms > 0), best = ok.length ? Math.min(...ok.map((x) => x.ms)) : -1;
  if (n.gatewayMs > 0) gwEver = true;
  netS.push({ t: n.t, gw: n.gatewayMs, in: best, dns: n.dnsMs }); if (netS.length > 180) netS.shift();
  const last = netS.filter((x) => x.t > netChanged).slice(-12), loss = last.length >= 6 ? last.filter((x) => x.in < 0).length / last.length : 0, slowN = last.slice(-6).filter((x) => x.in >= 200).length;
  n.best = best; n.loss = Math.round(loss * 100); cur.net = n;
  // routers that never answer a ping are common: "the router isn't answering" only counts if it ever did
  const want = !n.link ? "cable" : best > 0 ? (n.dnsMs < 0 && n.dns ? "dns" : (loss >= 0.25 || slowN >= 6) ? "slow" : "ok") : n.gatewayMs > 0 || !gwEver ? "down" : "router";
  if (want === netWant) netWantN++; else { netWant = want; netWantN = 1; }
  // a short drop (gone again before it counts as "No internet", under about 30 s) is still written down, once it's over
  const gone = want === "down" || want === "router" || want === "cable";
  if (gone && !netBlip) netBlip = { t: n.t, what: want, gw: n.gatewayMs };
  else if (!gone && netBlip) {
    const b = netBlip; netBlip = null;
    if (netState === "ok" || netState === "slow" || netState === "dns" || netState === "unknown" || !netState) {
      const secs = Math.max(5, Math.round((n.t - b.t) / 1000) + 5);           // readings are 10 s apart: it started up to 10 s before the first miss
      const where = b.what === "cable" ? "the network connection itself dropped (cable or Wi-Fi)" : b.what === "router" ? "the router stopped answering too" : "the router answered, the internet past it didn't (the modem or the provider)";
      incident("net", "warn", "The internet dropped for about " + secs + " s", "It came back by itself: " + where + ". In a game that's a disconnect or a long freeze. Several of these in a day point to the modem, the router or the provider.", { what: "blip", secs });
    }
  }
  const need = want === "ok" ? 2 : want === "dns" ? 4 : want === "slow" ? 1 : 3;
  if (want !== netState && netWantN >= need) {
    const was = openOf("net");
    if (was) closeIncident(was, want === "ok" ? "Back after " + span(Date.now() - was.t) + "." : "");
    netState = want; if (want === "ok" || want === "cable" || want === "down" || want === "router") netChanged = n.t;
    if (want !== "ok") { const [sev, title, text] = NET_TEXT[want]; incident("net", sev, title, text + (want === "slow" ? " Lost answers: " + n.loss + "%, reply time: " + (best > 0 ? best + " ms" : "none") + "." : ""), { open: true, what: want }); }
  }
  n.state = netState; X.tell("pc-live", live());
}

/* ---------------------------------------------------------------- what Windows wrote down */
const FIRMWARE = /firmware|microprogramme/i;
function classify(e) {
  const p = e.provider || "", id = e.id | 0, msg = String(e.message || "").replace(/\s+/g, " ").trim(), d = e.data || [];
  if (/Kernel-Power/i.test(p) && id === 41) return ["power", "bad", "The PC shut down or restarted without warning", "Windows found at start-up that it had not been shut down properly: a power cut, a hard reset, a freeze, or the PC losing power under load (power supply, overheating)."];
  if (/BugCheck|WER-SystemErrorReporting/i.test(p) && id === 1001) return ["bsod", "bad", "Blue screen", msg.slice(0, 400) || "Windows stopped with a blue screen and restarted."];
  if (/WHEA/i.test(p)) return ["hardware", e.level <= 2 ? "bad" : "warn", "Hardware error reported by the processor or motherboard", msg.slice(0, 400) || "WHEA event " + id + ". These come from the hardware itself: an unstable overclock or memory profile, overheating, or a failing part."];
  if (/^(disk|Ntfs|volmgr|stornvme|storahci)$/i.test(p) && e.level <= 3 && [7, 11, 15, 51, 52, 55, 98, 129, 153, 157].includes(id)) return ["diskerr", id === 7 || id === 52 || id === 55 ? "bad" : "warn", "Disk error (" + p + " " + id + ")", msg.slice(0, 400) || "Windows had trouble reading or writing a drive. Back up what matters and check the drive's health."];
  if (/^(Display|nvlddmkm|amdkmdag|amdwddmg|igfx)$/i.test(p) || (/DxgKrnl/i.test(p) && e.level <= 2)) return ["gpudrv", "warn", "The graphics driver stopped and recovered", msg.slice(0, 400) || "The screen froze or went black for a moment and the driver was restarted."];
  if (/Resource-Exhaustion/i.test(p)) return ["lowmem", "bad", "Windows ran low on memory", msg.slice(0, 400)];
  if (/Kernel-Processor-Power/i.test(p) && id === 37 && FIRMWARE.test(msg)) return ["throttle", "info", "The processor's speed is being limited by the firmware", msg.slice(0, 300)];
  if (p === "Application Error" && id === 1000) { const exe = d[0] || "A program"; if (X.games().includes(String(exe).toLowerCase())) return null; return ["appcrash", "warn", exe + " crashed", "In " + (d[3] || "an unknown file") + (d[6] ? ", error " + d[6] : "") + "."]; }
  if (p === "Application Hang" && id === 1002) { const exe = d[0] || "A program"; if (X.games().includes(String(exe).toLowerCase())) return null; return ["apphang", "info", exe + " stopped responding", "Windows closed it after it stopped answering."]; }
  return null;
}
let evBusy = false;
async function eventsTick() {
  if (!S().on || !X.helperOk() || evBusy) return;
  evBusy = true;
  try {
    const now = Date.now(), from = Math.max(DB.lastEv || now - 86400000, now - 7 * 86400000);
    const r = await X.ask("events", { from: from + 1, to: now }, 40000);
    if (!r || !r.ok) return;
    const list = (r.list || []).sort((a, b) => a.t - b.t); let once = {};
    for (const e of list) {
      const c = classify(e); if (!c) continue;
      const key = c[0] + c[2]; if (c[0] === "throttle") { if (DB.daily.throttle === dayOf(now)) continue; DB.daily.throttle = dayOf(now); }
      if (once[key]) { once[key].count++; continue; }
      const i = incident(c[0], c[1], c[2], c[3], { at: e.t, source: e.provider + " " + e.id }); once[key] = i;
      if (e.t && now - e.t > 180000) i.detail = "Happened at " + new Date(e.t).toLocaleString() + ". " + i.detail;
    }
    DB.lastEv = now; save();
  } finally { evBusy = false; }
}

function live() {
  const p = cur.pc, n = cur.net;
  return {
    on: S().on, netOn: S().net, helper: X.helperOk(), t: Date.now(),
    pc: p ? { cpu: p.cpu, cores: p.cores, ramTotal: p.ramTotal, ramFree: p.ramFree, commitTotal: p.commitTotal, commitFree: p.commitFree, gpu: p.gpu, vramMB: p.vramMB, vramTotalMB: p.vramTotalMB, gpuFan: p.gpuFan, gpuName: p.gpuName, gpuTemp: p.gpuTemp, gpuPower: p.gpuPower, drives: p.drives, nets: p.nets, upMs: p.upMs, procs: p.procs, topCpu: p.topCpu, topMem: p.topMem, rx: cur.rate.rx, tx: cur.rate.tx } : null,
    net: n ? { state: n.state || netState, link: n.link, adapter: n.adapter, wifi: n.wifi, mbps: n.mbps, gateway: n.gateway, gatewayMs: n.gatewayMs, dns: n.dns, dnsMs: n.dnsMs, pings: n.pings, best: n.best, loss: n.loss } : null,
    chart: { pc: pcS.slice(-120).map((s) => [s.t, s.cpu, s.ram, s.gpu, s.gt, s.rx]), net: netS.slice(-120).map((s) => [s.t, s.in, s.gw]) },
  };
}

/* ---------------------------------------------------------------- "Check my PC": a one-off look at its health */
function powershell(script, timeout) {
  return new Promise((res) => {
    if (process.platform !== "win32") return res({ ok: false, error: "Windows only" });
    const enc = Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue';" + script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, timeout: timeout || 45000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      const t = String(out || "").trim(), i = t.indexOf("{");
      if (i < 0) return res({ ok: false, error: err ? err.message.slice(0, 200) : "no answer" });
      try { res({ ok: true, data: JSON.parse(t.slice(i)) }); } catch (e) { res({ ok: false, error: "unreadable answer" }); }
    });
  });
}
// The same check, but run with administrator rights (one UAC prompt). It only unlocks a few reads that Windows keeps
// behind elevation — mainly a drive's own health counters (SMART: wear, temperature, uncorrected errors). Everything
// else works without it, which is why the normal check stays non-elevated. The elevated child writes its answer to a
// file (the output of a process started elevated can't be read back any other way), which this then reads and removes.
function powershellElevated(script, timeout) {
  return new Promise((res) => {
    if (process.platform !== "win32") return res({ ok: false, error: "Windows only" });
    const tmp = path.join(app.getPath("userData"), "health-" + Date.now() + ".json");
    const inner = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue';" + script.replace("$o | ConvertTo-Json -Depth 5 -Compress", "($o | ConvertTo-Json -Depth 5 -Compress) | Set-Content -LiteralPath '" + tmp + "' -Encoding UTF8");
    const encInner = Buffer.from(inner, "utf16le").toString("base64");
    const launcher = "try { $p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','" + encInner + "'; $p.WaitForExit(" + (timeout || 60000) + ") } catch { 'declined' }";
    const encL = Buffer.from(launcher, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encL], { windowsHide: true, timeout: (timeout || 60000) + 15000, maxBuffer: 2 * 1024 * 1024 }, () => {
      let data = null; try { const t = fs.readFileSync(tmp, "utf8"), i = t.indexOf("{"); if (i >= 0) data = JSON.parse(t.slice(i)); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch {}
      res(data ? { ok: true, data, elevated: true } : { ok: false, error: "the administrator step was refused or didn't finish" });
    });
  });
}
// each part answers by itself: one that fails (no rights, older Windows) leaves the others standing
const HEALTH_PS = `
function T($b){ try { & $b } catch { $null } }
$o = [ordered]@{}
$o.disks = T { @(Get-PhysicalDisk | ForEach-Object { $r = $null; try { $r = $_ | Get-StorageReliabilityCounter } catch {}; [ordered]@{ name=$_.FriendlyName; media=[string]$_.MediaType; bus=[string]$_.BusType; health=[string]$_.HealthStatus; status=[string]($_.OperationalStatus -join ','); size=[double]$_.Size; wear=$r.Wear; temp=$r.Temperature; readErr=$r.ReadErrorsUncorrected; writeErr=$r.WriteErrorsUncorrected; hours=$r.PowerOnHours } }) }
$o.ram = T { @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [ordered]@{ size=[double]$_.Capacity; speed=$_.Speed; running=$_.ConfiguredClockSpeed; maker=[string]$_.Manufacturer; part=([string]$_.PartNumber).Trim(); slot=[string]$_.DeviceLocator } }) }
$o.reboot = T { (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') }
$o.lastUpdate = T { $h = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1; if ($h) { $h.InstalledOn.ToString('yyyy-MM-dd') } }
$o.startup = T { @(Get-CimInstance Win32_StartupCommand | ForEach-Object { [string]$_.Name }) }
$o.defender = T { $m = Get-MpComputerStatus; [ordered]@{ realtime=$m.RealTimeProtectionEnabled; enabled=$m.AntivirusEnabled; age=$m.AntivirusSignatureAge } }
$o.minidumps = T { @(Get-ChildItem 'C:\\Windows\\Minidump' -Filter *.dmp | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }) }
$o.pagefile = T { $p = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1; if ($p) { [ordered]@{ size=$p.AllocatedBaseSize; peak=$p.PeakUsage } } }
$o.power = T { $l = (powercfg /getactivescheme) -join ' '; if ($l -match '\\((.+)\\)') { $Matches[1] } }
$o.cpu = T { $c = Get-CimInstance Win32_Processor | Select-Object -First 1; [ordered]@{ name=([string]$c.Name).Trim(); cores=$c.NumberOfCores; threads=$c.NumberOfLogicalProcessors } }
$o.board = T { $b = Get-CimInstance Win32_BaseBoard; $i = Get-CimInstance Win32_BIOS; [ordered]@{ maker=[string]$b.Manufacturer; model=[string]$b.Product; bios=[string]$i.SMBIOSBIOSVersion; biosDate=if ($i.ReleaseDate) { $i.ReleaseDate.ToString('yyyy-MM-dd') } else { '' } } }
$o.os = T { $w = Get-CimInstance Win32_OperatingSystem; [ordered]@{ name=[string]$w.Caption; build=[string]$w.BuildNumber; boot=$w.LastBootUpTime.ToString('o') } }
$o | ConvertTo-Json -Depth 5 -Compress
`;
// The same look on Linux, from what the system shows any user (no administrator rights asked): the drives, whether
// an update is waiting for a restart, the motherboard and its firmware, the power profile.
function sh(cmd, args, timeout) { return new Promise((res) => { try { execFile(cmd, args, { timeout: timeout || 5000, maxBuffer: 4 << 20 }, (e, out) => res(String(out || ""))); } catch { res(""); } }); }
// Deep check on Linux: each drive's own health counters, read by smartctl (smartmontools) after one password prompt from
// the system (pkexec). It only reads; the drive names come from lsblk and are checked before use.
async function smartDisks() {
  const smart = ["/usr/sbin/smartctl", "/usr/bin/smartctl", "/sbin/smartctl"].find((f) => fs.existsSync(f)), pk = ["/usr/bin/pkexec", "/bin/pkexec"].find((f) => fs.existsSync(f));
  if (!smart) return { missing: "smartctl" }; if (!pk) return { missing: "pkexec" };
  const devs = (await sh("lsblk", ["-dn", "-o", "NAME,TYPE"], 4000)).split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c[1] === "disk" && /^[a-z0-9]+$/.test(c[0]) && !/^(loop|zram|ram|sr|fd)/.test(c[0])).map((c) => c[0]);
  if (!devs.length) return { disks: [] };
  const out = await sh(pk, ["/bin/sh", "-c", devs.map((d) => 'echo "@@' + d + '"; ' + smart + " -j -a /dev/" + d).join("; ")], 180000);
  if (out.indexOf("@@") < 0) return { declined: true };
  const disks = [];
  for (const part of out.split(/^@@/m).slice(1)) {
    const nl = part.indexOf("\n"), dev = part.slice(0, nl).trim(); let j = null; try { j = JSON.parse(part.slice(nl + 1)); } catch { continue; }
    const attr = (id) => ((j.ata_smart_attributes && j.ata_smart_attributes.table) || []).find((a) => a.id === id), nv = j.nvme_smart_health_information_log || {};
    const life = attr(231) || attr(177) || attr(233), unc = (attr(187) && attr(187).raw.value) || 0, pend = (attr(198) && attr(198).raw.value) || 0;
    disks.push({ name: j.model_name || dev, media: (j.device && j.device.type === "nvme") || j.rotation_rate === 0 ? "SSD" : j.rotation_rate > 0 ? "HDD" : "", bus: ((j.device && j.device.protocol) || "").toUpperCase(), size: (j.user_capacity && j.user_capacity.bytes) || 0,
      health: j.smart_status ? (j.smart_status.passed ? "Healthy" : "Failing (its own self-test says so)") : "", wear: typeof nv.percentage_used === "number" ? nv.percentage_used : life ? Math.max(0, 100 - life.value) : undefined,
      temp: j.temperature ? j.temperature.current : undefined, readErr: typeof nv.media_errors === "number" ? nv.media_errors : unc + pend, writeErr: 0, hours: j.power_on_time ? j.power_on_time.hours : undefined });
  }
  return { disks };
}
async function linuxHealth(admin) {
  const rd = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } }, o = {};
  const rel = rd("/etc/os-release"); o.os = { name: ((/^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel) || [])[1]) || "Linux", build: os.release(), boot: new Date(Date.now() - os.uptime() * 1000).toISOString() };
  o.reboot = fs.existsSync("/var/run/reboot-required") || fs.existsSync("/run/reboot-required");
  const cpu = (/^model name\s*:\s*(.+)$/m.exec(rd("/proc/cpuinfo")) || [])[1] || "";
  o.cpu = { name: cpu.trim(), cores: Number(((/^cpu cores\s*:\s*(\d+)/m.exec(rd("/proc/cpuinfo")) || [])[1]) || 0) || os.cpus().length, threads: os.cpus().length };
  const bd = rd("/sys/class/dmi/id/bios_date"), m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(bd);
  o.board = { maker: rd("/sys/class/dmi/id/board_vendor"), model: rd("/sys/class/dmi/id/board_name"), bios: rd("/sys/class/dmi/id/bios_version"), biosDate: m ? m[3] + "-" + m[1] + "-" + m[2] : "" };
  const pp = (await sh("powerprofilesctl", ["get"], 3000)).trim(); if (pp) o.power = pp;
  if (admin) { const d = await smartDisks(); if (d.disks) o.disks = d.disks; o.smart = d; }
  return { ok: true, data: o, elevated: !!(o.disks && o.disks.length) };
}
let checking = null;
async function check(opts) {
  if (checking) return checking;
  const admin = !!(opts && opts.admin);
  checking = (async () => {
    const now = Date.now(), items = [], add = (sev, area, title, text, tip) => items.push({ sev, area, title, text: text || "", tip: tip || "" });
    const psP = LINUX ? linuxHealth(admin) : admin ? powershellElevated(HEALTH_PS, 60000).then((r) => (r && r.ok ? r : powershell(HEALTH_PS, 60000))) : powershell(HEALTH_PS, 60000);
    const [pcR, netR, evR, sysR, psR] = await Promise.all([X.ask("pc", { top: 1 }, 10000), S().net ? X.ask("net", { hosts: NET_HOSTS, name: "example.com" }, 8000) : null, X.ask("events", { from: now - 30 * 86400000, to: now }, 60000), X.ask("sysinfo", {}, 15000), psP]);
    const p = pcR && pcR.ok ? pcR.pc : cur.pc, n = netR && netR.ok ? netR.net : cur.net, ps = psR && psR.ok ? psR.data : {}, sys = sysR && sysR.ok ? sysR.info : {}, wasElevated = !!(psR && psR.elevated);
    if (!LINUX && (!psR || !psR.ok)) X.alog("pc check: the PowerShell part failed: " + ((psR && psR.error) || "?"));
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

    // Windows' own record of the last 30 days
    const ev = (evR && evR.ok ? evR.list : []).map((e) => ({ e, c: classify(e) })).filter((x) => x.c), count = (k) => ev.filter((x) => x.c[0] === k), when = (l) => l.length ? " Last: " + new Date(Math.max(...l.map((x) => x.e.t))).toLocaleString() + "." : "";
    const bs = count("bsod"), pw = count("power"), hw = count("hardware"), de = count("diskerr"), gd = count("gpudrv"), lm = count("lowmem"), ac = count("appcrash");
    if (LINUX && !bs.length) {}          // Linux doesn't keep a record of past kernel panics a program can read: nothing to say either way
    else if (bs.length) add("bad", "Stability", bs.length + " blue screen" + (bs.length > 1 ? "s" : "") + " in the last 30 days", when(bs) + " " + (bs[bs.length - 1].c[3] || ""), "The same stop code every time points to one driver or part; different codes each time point to memory or an unstable overclock / memory profile (XMP/EXPO). Test the memory, and update the motherboard BIOS and chipset drivers.");
    else add("ok", "Stability", "No blue screens in the last 30 days");
    if (pw.length) add(pw.length > 2 ? "bad" : "warn", "Stability", pw.length + " shutdown" + (pw.length > 1 ? "s" : "") + " without warning in the last 30 days", when(pw), "If you didn't hold the power button or lose power: a PC that cuts out under load usually has a power supply that can't keep up or is overheating. A freeze you had to reset counts here too.");
    if (hw.length) add("bad", "Hardware", hw.length + " hardware error" + (hw.length > 1 ? "s" : "") + " reported by the processor or motherboard", when(hw) + " " + String(hw[hw.length - 1].c[3]).slice(0, 220), "These are the hardware saying it made a mistake. Turn off overclocks and the memory profile (XMP/EXPO) for a test, check temperatures, update the BIOS.");
    else add("ok", "Hardware", "No hardware errors reported by the processor or motherboard");
    if (de.length) add("bad", "Drives", de.length + " disk error" + (de.length > 1 ? "s" : "") + " in Windows' log", when(de) + " " + String(de[de.length - 1].c[3]).slice(0, 220), "Back up what matters now. Then check the drive below, its cable (SATA) and run 'chkdsk /scan' from an administrator terminal.");
    if (gd.length) add(gd.length > 3 ? "bad" : "warn", "Graphics", "The graphics driver stopped and recovered " + gd.length + " time" + (gd.length > 1 ? "s" : ""), when(gd), "Reinstall the graphics driver cleanly, remove any GPU overclock or undervolt, and check the card's power cables. If it keeps happening in every game, the card itself is the suspect.");
    if (lm.length) add("warn", "Memory", "Windows ran low on memory " + lm.length + " time" + (lm.length > 1 ? "s" : ""), when(lm), "Leave the page file on 'system managed' on a drive with free room, and close what you don't need while playing.");
    if (ac.length) { const by = {}; for (const x of ac) by[x.e.data[0] || "?"] = (by[x.e.data[0] || "?"] || 0) + 1; const topA = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5); add(ac.length > 10 ? "warn" : "info", "Programs", ac.length + " program crash" + (ac.length > 1 ? "es" : "") + " in the last 30 days", topA.map(([k, v]) => k + " ×" + v).join(", ") + ".", "One program crashing a lot is that program's problem. Many different ones crashing points at the PC (memory, drivers)."); }

    // memory
    if (p) {
      const ramGB = p.ramTotal / 1073741824, used = 1 - p.ramFree / p.ramTotal;
      add(used > 0.9 ? "warn" : "ok", "Memory", Math.round(ramGB) + " GB of memory, " + Math.round(used * 100) + "% in use right now", (p.topMem || []).slice(0, 4).map((x) => x.name + " " + GB(x.mem)).join(", "), used > 0.9 ? "Close what you don't need before starting a game." : "");
      if (ramGB < 15.5) add("warn", "Memory", "Only " + Math.round(ramGB) + " GB of memory", "", "Current games expect 16 GB or more; with less, they stutter and can crash when it fills up.");
    }
    const sticks = arr(ps.ram);
    if (sticks.length) {
      const slow = sticks.filter((x) => x.speed && x.running && x.running < x.speed - 100);
      if (slow.length) add("info", "Memory", "The memory runs at " + slow[0].running + " MHz, its label says " + slow[0].speed + " MHz", sticks.length + " module" + (sticks.length > 1 ? "s" : "") + ".", "Its faster profile (XMP / EXPO) is not switched on in the BIOS. Turning it on is free speed; if the PC ever becomes unstable afterwards, turn it back off.");
      if (sticks.length === 1 && sticks[0].size >= 8 * 1073741824) add("info", "Memory", "A single memory module", "", "Two matched modules (dual channel) are noticeably faster in games than one.");
    }
    const pf = ps.pagefile; if (pf && pf.size && pf.peak && pf.peak > pf.size * 0.9) add("warn", "Memory", "The page file was almost full at its peak (" + pf.peak + " of " + pf.size + " MB)", "", "Let Windows manage its size, and keep free room on that drive.");

    // drives
    for (const d of (p && p.drives) || []) { const pct = d.total ? d.free / d.total : 1; add(pct < 0.05 ? "bad" : pct < 0.12 ? "warn" : "ok", "Drives", "Drive " + d.name + (d.label ? " (" + d.label + ")" : "") + ": " + GB(d.free) + " free of " + GB(d.total), "", pct < 0.12 ? "Free some room: solid-state drives slow down a lot when nearly full, and Windows needs space on C: for updates." : ""); }
    for (const d of arr(ps.disks)) {
      const bad = d.health && !/healthy|sain/i.test(d.health), wear = typeof d.wear === "number" ? d.wear : null, errs = (d.readErr || 0) + (d.writeErr || 0);
      const facts = [d.media && d.media !== "Unspecified" ? d.media : "", d.bus, d.size ? GB(d.size) : "", wear !== null ? "wear " + wear + "%" : "", typeof d.temp === "number" && d.temp > 0 ? d.temp + " °C" : "", d.hours ? Math.round(d.hours / 24) + " days powered on" : ""].filter(Boolean).join(" · ");
      add(bad || errs > 0 ? "bad" : wear !== null && wear >= 80 ? "warn" : typeof d.temp === "number" && d.temp >= 70 ? "warn" : "ok", "Drives", (d.name || "Drive") + ": " + (bad ? "Windows reports its health as " + d.health : errs > 0 ? errs + " uncorrected read/write errors" : "healthy"), facts, bad || errs > 0 ? "Back up this drive now and plan to replace it." : wear !== null && wear >= 80 ? "This SSD has used most of its rated life. Keep backups." : typeof d.temp === "number" && d.temp >= 70 ? "This drive runs hot; an NVMe heatsink or more airflow helps." : "");
    }
    if (!arr(ps.disks).length) add("info", "Drives", "Drive health couldn't be read", "", LINUX ? (ps.smart && ps.smart.missing === "smartctl" ? "The deep check reads it with smartctl, which isn't installed: install the smartmontools package, then press “Deep check” again." : ps.smart && ps.smart.missing === "pkexec" ? "The deep check needs pkexec (polkit) to ask for your password, and it isn't on this system." : ps.smart && ps.smart.declined ? "The password prompt was closed, so the drives' own health wasn't read." : "A drive's own health (wear, temperature, errors) needs administrator rights on Linux. “Deep check (asks for your password)” reads it with smartctl.") : wasElevated ? "Windows didn't report the drives' own health counters on this PC." : "A drive's own health (wear, temperature, errors) is kept behind administrator rights. Use “Deep check (as administrator)” to read it.");
    else if (!arr(ps.disks).some((d) => typeof d.wear === "number" || typeof d.temp === "number" || d.readErr != null) && !wasElevated) add("info", "Drives", "Drive wear and temperature need administrator rights", "", "Use “Deep check (as administrator)” for each drive's SMART health (how much life it has used, its temperature, and any errors).");

    // graphics
    const g = (sys.gpus || []).find((x) => /nvidia|amd|radeon|geforce|intel.*arc/i.test(x.name || "")) || (sys.gpus || [])[0];
    if (g) {
      let age = -1; const m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(g.driverDate || ""); if (m) age = (now - new Date(+m[3], +m[1] - 1, +m[2]).getTime()) / 86400000;
      add(age > 365 ? "warn" : "ok", "Graphics", g.name + ", driver " + (g.driver || "?") + (age >= 0 ? " (" + (age > 60 ? Math.round(age / 30) + " months old" : Math.round(age) + " days old") + ")" : ""), "", age > 365 ? "The graphics driver is over a year old. New games often need a newer one." : "");
      if (p && p.gpuTemp > 0) add(p.gpuTemp >= 87 ? "warn" : "ok", "Graphics", "Graphics card temperature: " + Math.round(p.gpuTemp) + " °C right now", "", p.gpuTemp >= 87 ? "Hot. Clean the dust from its fans and check the case airflow." : "");
    }

    // internet
    if (n) {
      const ok = (n.pings || []).filter((x) => x.ms > 0), best = ok.length ? Math.min(...ok.map((x) => x.ms)) : -1;
      if (!n.link) add("bad", "Internet", "No network connection", "", NET_TEXT.cable[2]);
      else if (best < 0) add("bad", "Internet", "The internet isn't answering", "Router: " + (n.gatewayMs > 0 ? n.gatewayMs + " ms" : "no answer"), n.gatewayMs > 0 ? NET_TEXT.down[2] : NET_TEXT.router[2]);
      else add(best >= 120 ? "warn" : "ok", "Internet", "Internet answers in " + best + " ms" + (n.gatewayMs > 0 ? ", the router in " + n.gatewayMs + " ms" : ""), (n.wifi ? "Wi-Fi" : "Cable") + (n.mbps ? " at " + n.mbps + " Mbps" : "") + (n.adapter ? " (" + n.adapter + ")" : ""), best >= 120 ? "That is slow for games. Test with a cable if you are on Wi-Fi." : "");
      if (n.link && n.dns && n.dnsMs < 0) add("warn", "Internet", "The name server (" + n.dns + ") didn't answer", "", NET_TEXT.dns[2]);
      if (n.link && !n.wifi && n.mbps > 0 && n.mbps <= 100) add("warn", "Internet", "The network cable is linked at only " + n.mbps + " Mbps", "", "A gigabit card linked at 100 Mbps means a worn or low-grade cable, or a bad plug. Reseat or replace the cable.");
      if (n.wifi) add("info", "Internet", "This PC is on Wi-Fi", "", "A cable gives steadier ping in games.");
    }
    const netInc = DB.incidents.filter((i) => i.kind === "net" && now - i.t < 7 * 86400000);
    if (netInc.length) add(netInc.length > 5 ? "warn" : "info", "Internet", netInc.length + " connection problem" + (netInc.length > 1 ? "s" : "") + " seen in the last 7 days", netInc.slice(0, 3).map((i) => new Date(i.t).toLocaleString() + ": " + i.title + (i.end ? " (" + span(i.end - i.t) + ")" : "")).join(" | "), "");

    // Windows
    if (ps.os) { let up = -1; try { up = (now - new Date(ps.os.boot).getTime()) / 86400000; } catch {} add(up > 10 ? "info" : "ok", "Windows", (ps.os.name || "Windows") + " (" + (LINUX ? "kernel " : "build ") + ps.os.build + ")" + (up >= 0 ? ", running for " + (up < 1 ? Math.round(up * 24) + " hours" : Math.round(up) + " days") : ""), "", up > 10 ? "A restart now and then clears a lot of small problems. (Shut down with Fast Startup on doesn't count as one.)" : ""); }
    if (ps.reboot === true) add("warn", "Windows", "Windows is waiting for a restart to finish updates", "", "Half-installed updates cause odd crashes. Restart the PC.");
    if (ps.lastUpdate) { const age = (now - new Date(ps.lastUpdate).getTime()) / 86400000; add(age > 75 ? "warn" : "ok", "Windows", "Last Windows update installed on " + ps.lastUpdate, "", age > 75 ? "No update for over two months: check Windows Update." : ""); }
    if (ps.defender) add(ps.defender.realtime === false ? "warn" : "ok", "Windows", "Windows Security: real-time protection is " + (ps.defender.realtime === false ? "off" : "on"), typeof ps.defender.age === "number" ? "Definitions " + ps.defender.age + " day(s) old." : "", ps.defender.realtime === false ? "If you didn't turn it off yourself for another antivirus, turn it back on." : "");
    const st = arr(ps.startup); if (st.length) add(st.length > 18 ? "info" : "ok", "Windows", st.length + " programs start with Windows", st.slice(0, 12).join(", ") + (st.length > 12 ? "…" : ""), st.length > 18 ? "Each one uses memory and can hook into games. Task Manager > Startup apps lets you turn off the ones you don't need." : "");
    if (ps.power && !/high|ultimate|performance|performances|élev|optim/i.test(ps.power) && !/balanced|équilibr|utilisation normale/i.test(ps.power)) add("info", "Windows", "Power plan: " + ps.power, "", "A power-saving plan holds the processor back in games.");
    const md = arr(ps.minidumps); if (md.length) add("info", "Stability", md.length + " blue-screen memory dump" + (md.length > 1 ? "s" : "") + " on this PC", "Newest: " + md[0] + ". They are in C:\\Windows\\Minidump.", "");
    if (ps.board && ps.board.biosDate) { const age = (now - new Date(ps.board.biosDate).getTime()) / (365 * 86400000); add("info", "Hardware", (ps.board.maker + " " + ps.board.model).trim() + ", BIOS " + ps.board.bios + " from " + ps.board.biosDate, ps.cpu ? ps.cpu.name + " (" + ps.cpu.cores + " cores, " + ps.cpu.threads + " threads)" : "", age > 2 ? "The BIOS is over two years old. Newer ones fix stability and memory problems; update it only when the PC is otherwise stable and never during a storm." : ""); }

    if (LINUX) for (const i of items) { i.title = linuxWords(i.title); i.text = linuxWords(i.text); i.tip = linuxWords(String(i.tip || "").replace(/ and run 'chkdsk \/scan' from an administrator terminal/, " and its file system (fsck, from a live USB)").replace(/ \(Shut down with Fast Startup on doesn't count as one\.\)/, "")); if (i.area === "Windows") i.area = "System"; }
    const order = { bad: 0, warn: 1, info: 2, ok: 3 }; items.sort((a, b) => order[a.sev] - order[b.sev]);
    const res = { at: now, items, bad: items.filter((i) => i.sev === "bad").length, warn: items.filter((i) => i.sev === "warn").length, partial: !LINUX && (!psR || !psR.ok), elevated: wasElevated };
    DB.health = res; save();
    try { const dir = path.join(X.DATA, "_PC"); fs.mkdirSync(dir, { recursive: true }); const d = new Date(now); fs.writeFileSync(path.join(dir, "check " + dayOf(now) + " " + z(d.getHours()) + "." + z(d.getMinutes()) + ".txt"), "aGoldenDiagnose: PC check, " + d.toLocaleString() + "\r\n" + os.hostname() + "\r\n\r\n" + items.map((i) => "[" + ({ bad: "PROBLEM", warn: "WARNING", info: "NOTE", ok: "OK" })[i.sev] + "] " + i.area + ": " + i.title + (i.text ? "\r\n      " + i.text : "") + (i.tip ? "\r\n      -> " + i.tip : "")).join("\r\n") + "\r\n"); } catch {}
    logLine(now, "CHECK    " + res.bad + " problem(s), " + res.warn + " warning(s)");
    X.alog("pc check: " + res.bad + " problems, " + res.warn + " warnings, " + items.length + " lines" + (res.partial ? " (PowerShell part missing)" : ""));
    return res;
  })();
  try { return await checking; } finally { checking = null; }
}

/* ---------------------------------------------------------------- keep alive, and asking before quitting */
const OLD_TASK = "aGoldenDiagnose keep alive";       // the scheduled task used in 1.8/1.9 — removed, Windows Defender flags any app that makes one
const target = () => AUTOSTART.exe();
const flagFile = () => path.join(app.getPath("userData"), "quit-on-purpose.flag");
let onPurpose = false, cleaned = false;
/* Keep alive, without anything that looks like malware to antivirus (no scheduled task, nothing dropped in a folder and
 * run from there). Two honest parts:
 *   - the app and the watcher each start the other again if it dies on its own (crash, or one of them ended): they watch
 *     each other while both run;
 *   - the app is set to open (hidden, in the tray) when you sign in to Windows, the normal way, so a restart brings it back.
 * Ending both at once (Task Manager "End task tree") still stops it until the next sign-in; there is no way around that
 * that antivirus wouldn't rightly flag. */
function cleanupOldTask() {
  if (cleaned || process.platform !== "win32") return; cleaned = true;
  execFile("schtasks.exe", ["/Delete", "/F", "/TN", OLD_TASK], { windowsHide: true, timeout: 15000 }, () => {});
  try { fs.unlinkSync(path.join(app.getPath("userData"), "agd-keepalive.exe")); } catch {}
  try { fs.unlinkSync(path.join(app.getPath("userData"), "keepalive.txt")); } catch {}
}
async function applyKeepAlive() {
  if (process.platform !== "win32" && !LINUX) return;
  cleanupOldTask();
  const on = !!S().keepAlive;
  X.ask("keepalive", { exe: target(), on: on ? 1 : 0 });          // the watcher brings the app back if the app dies while the watcher lives
  // open with Windows when keep alive is on (or when the separate "Start with Windows" is on): a normal login item
  try { AUTOSTART.set(app, on || !!X.cfg().startup); } catch (e) { X.alog("keep alive: " + e.message); }
}
/** The tray's Quit, or the X when it isn't set to hide: really quit? */
exports.beforeQuit = function (from) {
  if (X && S().askQuit) {
    const w = X.getWin(), r = dialog.showMessageBoxSync(w && !w.isDestroyed() && w.isVisible() ? w : undefined, { type: "question", title: "aGoldenDiagnose", message: "Quit aGoldenDiagnose?", detail: "While it is closed nothing is watched: no crash reports for your games, and no record of PC or internet problems.", buttons: ["Keep it running", "Quit"], defaultId: 0, cancelId: 0, noLink: true });
    if (r !== 1) return false;
  }
  onPurpose = true; try { fs.writeFileSync(flagFile(), String(Date.now())); } catch {}
  return true;
};

/* ---------------------------------------------------------------- start */
exports.start = function (x) {
  X = x; load();
  try { fs.unlinkSync(flagFile()); } catch {}
  const revived = (process.argv.find((a) => a.startsWith("--revived=")) || "").slice(10);
  if (revived) setTimeout(() => incident("revived", "info", "aGoldenDiagnose was closed and started itself again", revived === "task" ? "It wasn't running, so the keep-alive check opened it." : "It was ended from outside (Task Manager, or it crashed), and keep alive brought it back."), 3000);
  setInterval(() => pcTick().catch(() => {}), 5000);
  setInterval(() => netTick().catch(() => {}), 10000);
  setTimeout(() => eventsTick().catch(() => {}), 15000); setInterval(() => eventsTick().catch(() => {}), 60000);
  app.on("before-quit", () => { if (!onPurpose) return; try { fs.writeFileSync(flagFile(), String(Date.now())); } catch {} });
  ipcMain.handle("pc-state", () => ({ live: live(), incidents: DB.incidents.slice(0, 200), settings: S(), health: DB.health, logDir: LOGDIR() }));
  ipcMain.handle("pc-settings", (_e, v) => {
    const s = S(); v = v || {};
    for (const k of ["on", "net", "notify", "keepAlive", "askQuit"]) if (typeof v[k] === "boolean") s[k] = v[k];
    if (v.ramPct) s.ramPct = Math.max(70, Math.min(99, v.ramPct | 0)); if (v.gpuTemp) s.gpuTemp = Math.max(60, Math.min(100, v.gpuTemp | 0));
    X.save(); if (typeof v.keepAlive === "boolean") applyKeepAlive(x.helperPath());
    if (v.net === false || v.on === false) { const o = openOf("net"); if (o) closeIncident(o, "Watching was turned off."); netState = "ok"; }
    return s;
  });
  ipcMain.handle("pc-check", (_e, a) => check(a));
  ipcMain.handle("pc-clear", () => { DB.incidents = DB.incidents.filter((i) => i.open); save(); return true; });
  ipcMain.handle("pc-folder", () => { const d = path.join(X.DATA, "_PC"); try { fs.mkdirSync(LOGDIR(), { recursive: true }); } catch {} shell.openPath(d); return true; });
};
/** Called each time the helper has (re)started. */
exports.helperReady = function (helperExe) { applyKeepAlive(helperExe); };
