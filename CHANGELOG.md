# Changelog

Every version of aGoldenDiagnose, and everything that changed in it. Nothing is left out: each release on this page also
lists the files that changed and links to the exact line-by-line differences, which GitHub produces from the code itself,
so this list can always be checked against what really changed.

## 1.42 - 2026-11-26

- **Windows shortcuts** (new): a row on the PC tab, under the tiles, with buttons that open Windows' own tools: Device Manager, Task Manager, Startup apps, Windows Update, Network connections and settings, Display, Graphics settings, Sound, Power, Storage, Disk Management, Reliability history, Event Viewer, Resource Monitor, Advanced system settings, Installed apps, Windows Security and About this PC. It folds away (click its heading). Each tile's page also has the few that go with it (for example Network: Device Manager, Network connections, Network settings). Only this fixed list can be opened. `web/pc.js` (`quickRow`), `desktop/pc.js` (`pc-open`).
- **Fixed: a wrong step for some network cards.** After an internet drop, the app could say to set “EEE Max Support Speed” to Disabled, a choice that setting doesn't have: it isn't an on/off switch, it only sets up to which speed power saving is used. The app now reads each setting's own list of choices, only suggests turning off real on/off switches, suggests the exact “off” choice that list offers (Disabled, Off…), and says so when Energy-Efficient Ethernet is already off. The “test at a lower link speed” step now points at “Speed & Duplex”, not at the power-saving speed. `desktop/pc.js` (`netAdvice`).
- **Buttons and links next to the steps** (new): a step that names a Windows tool has a button that opens it (Device Manager, Task Manager's Startup apps, Windows Update, Storage, Power, Backup, Windows Security, Windows Memory Diagnostic, Advanced system settings, Disk Cleanup, Troubleshoot). Steps that need a download link to it (graphics drivers from NVIDIA, AMD or Intel, MemTest86, WinDbg, BlueScreenView, LibreHardwareMonitor, cloning tools), and driver and BIOS steps open a search for your exact network card or motherboard. Only that fixed list of Windows tools can be opened this way. `web/pc.js` (`stepButtons`), `desktop/pc.js` (`pc-open`).
- **Ask about it** (new): under each internet drop, each Check my PC finding and each tile's page, a box to say what doesn't match or to ask a question. **✨ Ask** sends your question, with what the app found and suggested (and, for a network card, each setting's list of choices), to the AI you set up in Settings → AI (your own Claude key, or a local AI model on this PC), and the answer stays under that problem. Nothing is sent unless you press it. **Report it** opens this page's issue form in your browser, filled in with your message and what the app suggested, for you to check and post. `web/pc.js` (`askBox`), `web/diagnose.js` (`askAI`).
- `README.md`: “What it sends over the internet” now lists **Ask about it**, and says **Report it** only opens the issue form.

## 1.41 - 2026-11-26

- Never published on its own: everything in it is listed under 1.42 above.

## 1.40 - 2026-11-26

- Never published on its own: everything in it is listed under 1.42 above.

## 1.39 - 2026-11-26

**The PC tab**

- **Each tile opens in detail** (new): click Processor, Memory, Graphics card, Internet or Network. The page shows a bigger chart, everything the app reads about it right now (model, driver, temperatures, video memory, reply times, the network card and its settings…), the programs using it most, every problem the app saw with it, what Windows' own log wrote about it in the last 14 days, and what you can do. **← Back** or **Esc** returns. `web/pc.js`, `web/index.html`, `desktop/pc.js` (`detail`).
- **Easier to read tiles:** each tile has the same labelled lines (Temp, Threads, Used, VRAM, Router…) instead of one sentence, and the numbers keep the same width, so the tile no longer grows or shrinks while the values change. `web/pc.js`, `web/index.html`.
- **Temperatures** (new): each drive's own sensor (Windows' storage temperature query, no administrator rights needed for most drives) in the Drives list and on the Processor page, with a warning when a drive passes its own limit; the motherboard's ACPI zone when Windows reports one; and the processor's, the memory's and the motherboard's sensors when LibreHardwareMonitor is running (see the README: Windows has no way to read those without a driver, and this app doesn't install one). The graphics card's was already there. A warning when the processor stays at 90 °C or more. On Linux all of them come from the kernel's sensors. `desktop/helper/AgdHelper.cs` (`Temps`), `desktop/pc.js` (`tempTick`, `readLhm`, `readHwmon`).
- **Internet drops are looked into** (new): when a drop ends, the app reads (without changing anything) the network card in use, its driver and its date, its power-saving settings (Energy-Efficient Ethernet, Green Ethernet…), whether Windows may turn it off, what Windows wrote in its log around the drop, and how often the card reported its link going down in the last 7 days. Opening the drop shows **What the app found** and **What to try**, step by step, for that kind of drop: this PC's connection, the router, or past the router. Older drops have a **Look into it** button. `desktop/pc.js` (`netDiag`, `netAdvice`), `web/pc.js`.
- **Check my PC: what to do, and Ignore** (new): each finding has **What to do**, with steps for that finding (a worn SSD, startup programs, an old BIOS, blue-screen dumps, drivers, memory…). **Ignore** hides a finding and leaves it out of the count; it waits under "ignored", where **Unignore** brings it back. `desktop/pc.js` (`healthSteps`), `web/pc.js`.

**Also in this version**

- **Archive old reports** (new): on the Reports tab, each report has a **✕** that moves it to **Archived reports** at the bottom of the list, and when some are older than 30 days, **Archive them** does those all at once. Archiving only hides a report from the list: its folder and files stay where they are, it can still be opened from the archive, **Bring back** (or **Bring them all back**) returns it, and Patterns still count it. The archive is kept with the app's other settings on this PC. `web/diagnose.js`.
- **Internet outage report** (new): PC tab → What went wrong → **Outage report**. Pick two dates and it lists every time the internet dropped or was unstable in between: the date, when it started and ended, how long it lasted, and which part was down (this PC's connection, the router, or the internet past the router). A summary at the top counts the drops, the total time down, the longest one and the worst days, and says how many were past the router, which points to the modem or the internet provider rather than the home network. **Copy** puts it on the clipboard to paste in an e-mail or a chat with your provider; **Save as a .txt** puts it in `Downloads\aGoldenDiagnose`. Nothing is sent anywhere. `web/pc.js`, `web/index.html`, `desktop/pc.js`, `desktop/preload.js`.
- Drops are now kept in their own list (up to about 3000), so the report can go back months instead of only as far as the newest 400 entries of "What went wrong". Drops from before this version are taken from that list. `desktop/pc.js`.
- The check that runs before this page is updated now lives in its own file, `desktop/public-guard.js`, which stays with the author and isn't part of this page or the app. It checks the same things as before, and also the author's personal details. `desktop/public-source.js`.
- `CHANGELOG.md`: the heading of 1.33 below had been left out by mistake; it's back.

## 1.38 - 2026-11-26

- Never published on its own: everything in it is listed under 1.39 above.

## 1.37 - 2026-11-26

- Never published: its build stopped itself before anything was made (a check found that a shared copy would have included a part that only applies to the author's own PC), and nothing was released. Everything is listed under 1.39 above.

## 1.36 - 2026-11-26

- Never published on its own: everything in it is listed under 1.39 above.

## 1.35 - 2026-11-26

- Never published on its own: everything in it is listed under 1.39 above.

## 1.34 - 2026-11-26

- Never published on its own: everything in it is listed under 1.39 above.

## 1.33 - 2026-11-26

- **This page was cleaned up.** Some code comments and some notes below mentioned things that are not part of aGoldenDiagnose. They were reworded or taken out, and code that only applied to the author's own PC is no longer in this copy. No change to what the app does for you. `CHANGELOG.md`, comments in `web/` and `desktop/`, `desktop/watch.js`, `desktop/helper/AgdHelper.cs`.
- Because of that, this repository's history starts again from this version: the downloads and line-by-line differences of earlier versions are no longer on this page. Their notes are all kept below.

## 1.32 - 2026-11-26

- **Short internet drops are written down.** A drop that ended before it counted as "No internet" (under about 30 seconds) left only a red mark on the chart. Now, once it's over, the PC tab notes "The internet dropped for about N s", with whether the cable or Wi-Fi, the router or the internet past it was gone, and you get the usual notification if that's on. `desktop/pc.js`.
- **Patterns** on the Reports tab fold away (click the heading; it stays the way you left it), and each pattern has a **✕** that dismisses it into an **Archive** at the bottom of the card, where **Bring back** returns it. `web/diagnose.js`, `web/analyze.js` (each pattern has a stable key).

## 1.31 - 2026-11-26

- No change to the app in this copy. This version only changed something specific to the author's own PC, which isn't part of this copy.

## 1.30 - 2026-11-26

- **Claude through your own sync server** (optional, off by default): when you're signed in to your own sync server in Settings → Sync and it offers this, Settings → AI can send "Explain" and "Find fixes" through that server instead of using a key typed into this app (the server keeps the key). Nothing changes unless you turn it on. `web/diagnose.js` (`claude`), `web/index.html`, `desktop/watch.js` (`diag-ai`), `desktop/preload.js`.

## 1.29 - 2026-11-26

- **Explain with a local AI model** (new, off by default): Settings → AI → "Explain with a local AI model instead". With [Ollama](https://ollama.com) running on the same PC and a model downloaded (for example `ollama pull qwen3:32b`), **✨ Explain (local AI)** on a report sends the report only to that model on your own PC, so it never leaves it and costs nothing. "Find fixes" still uses Claude, since it searches the web. The app only ever talks to `127.0.0.1` / `localhost` for this. `web/diagnose.js`, `web/index.html`, `desktop/watch.js`.

## 1.28 - 2026-11-26

**New on a report** (`web/diagnose.js`, `desktop/watch.js`, `desktop/preload.js`)

- **Copy for Discord:** a short version of the report (under Discord's 2000-character limit) with the error lines in a code block, ready to paste when asking for help. Your user name, your home folder's name and your PC's name are replaced with stars in it. `web/analyze.js` (`discordText`).
- **Verify the game's files** (games in a Steam library): asks Steam to check the game's files and replace any that are damaged or missing, the same as Steam's own Properties → Installed files → Verify. The app finds the game's Steam number from the library's own `appmanifest` files.
- **Clear shader caches…:** lists the shader caches the graphics drivers keep (NVIDIA, AMD, Intel, DirectX on Windows; NVIDIA and Mesa in `~/.cache` on Linux) and this game's Steam shader cache, with their sizes, and clears them only after you confirm. They're rebuilt by themselves. Files in use are left alone. Nothing else is deleted.
- **Linux:** a report shows which **Proton** version the game ran with (read from the game's `compatdata` folder).

**Patterns**

- **Problems since the graphics driver changed**, or since Windows (or the Linux kernel) changed: when most of the last 30 days' problems came after such a change, the Reports tab says so, with the version before and after. Each report now remembers the main graphics card, its driver version and the system's version for this. `web/analyze.js` (`patterns`).

**Other** (no change to what this app does)

- `web/index.html`: the theme code can also tell an Android wrapper which colour to give the phone's status bar. This app has no Android version, so here it does nothing.

## 1.27 - 2026-11-26

**Themes and layout**

- **Theme: Dark, Light or AMOLED** (new): Settings → Display → Theme. AMOLED is pure black, which switches those pixels off on a phone or OLED screen. The choice is kept in the app's own settings on your PC. Dark stays the default. `web/index.html`, `web/common.css` (colours that were written out by hand now follow the theme; Dark looks exactly as before).
- **Settings → Display**: Text size moved into its own Display card, next to Theme.
- Section headings in Settings use gold small capitals, and on/off rows all look the same (text on the left, switch on the right).
- **Back** is the same everywhere: the report's back button now says **← Back**, and **Esc** closes a report or an inner screen. `web/diagnose.js`, `web/index.html`.

## 1.26 - 2026-11-26

- No change to the app. It was built to publish the note under 1.25 below; no entry was written for it at the time.

## 1.25 - 2026-11-26

**Safety and trust**

- **Electron updated from 33 to 45** (45.4.1), the part that runs the app's window. Version 33 no longer got security fixes. The build tool (electron-builder) went from 25 to 26 with it. `desktop/package.json`.
- **Signed build attestations:** each download now carries a record, signed by GitHub, of which build run and which commit of this repository made it. `gh attestation verify <file> -R SirGoldenTaco/agoldendiagnose-app` checks it. The release notes say how.
- **Virus scans** (optional): when this repository has a VirusTotal key, both downloads are sent to VirusTotal right after they are built, and the release notes link to the results.
- **The log-upload code is gone from this copy.** It was already switched off here (no address, no key), but it was still in `web/common.js`. Now the app's own log only goes to the window's developer console.
- **Issue forms** that remind people to keep personal details out of what they post, and a **security policy** (`.github/SECURITY.md`) for reporting security problems privately.

**New for both systems**

- **Patterns** on the Reports tab: what the reports say together. The same game failing again and again (with how often, what kind of failure, and in which file), the same failure or the same driver file in the crashes of different games, and several games failing within 15 minutes of each other, which points to the PC rather than the games. `web/analyze.js` (`patterns`), `web/diagnose.js`. Each report now also remembers which file the crash happened in (`desktop/watch.js`).

**This page, after the 1.25 release** (no change to the app)

- Virus scans are on: both 1.25 downloads were sent to VirusTotal and the links were added to the 1.25 release notes. A release that has no scan yet gets one within the hour.
- Every GitHub action the build uses is pinned to an exact commit, so nothing can change underneath it; the two build jobs can only read the code; and the checkouts that don't push don't keep a token.

**Linux**

- The app tells the desktop which menu entry it belongs to, so its windows group under the right icon (`desktopName` in `desktop/package.json`).

## 1.24 - 2026-11-26

**Linux**

- **Steam launch option** (new, optional): Settings → Linux → **Copy the launch option** writes a small script, `~/.local/share/aGoldenDiagnose/agd-run.sh`, and copies the line to paste into a game's launch options in Steam. A game started that way gets its real exit code (or the signal that ended it) and everything it printed into its report; it is watched even when watching by itself is off; and if the app was closed during the run, the report is made the next time it opens. The script writes a few small files per run in `~/.local/share/aGoldenDiagnose/runs`, which the app deletes once the report is made (anything left is deleted after 7 days). New file: `desktop/linux-runs.js`.
- **Proton's own log** (new, off by default): for games started through the launch option, Proton writes its detailed log, which is added to the report.
- **Crash reports from Ubuntu and Mint**: crashes recorded in `/var/crash` (apport) are now read, not only systemd's core dumps.
- **Graphics use per game on AMD and Intel cards**, from the kernel's own per-program counters. Before, only NVIDIA cards showed it.
- **Deep check (asks for your password)**: reads each drive's own health with `smartctl` after one password prompt from the system (`pkexec`). It only reads, and only when you press the button. If `smartctl` isn't installed, the check says so.
- **Show in the applications menu** (new, off by default): adds the app to the desktop's applications menu; turning it off removes it.
- Reports on Linux: lines from Proton and Wine (unhandled page faults, device lost, GPU hangs) are recognised in logs; a graphics-driver failure quotes the system log's own line; the web searches use the words Linux players use ("Proton segfault crash"); a game ended by force (SIGKILL) or asked to close (SIGTERM) is said so plainly.
- Fixed: games found through the launch option weren't picked up when "Watch games from my launchers by themselves" was off.

**Both systems**

- **Hide your names when exporting** (new): exporting a report as a .zip asks whether to replace your user name, your home folder's name and your PC's name with stars in every file of the .zip. The report kept on your PC isn't changed. Cancel stops the export.
- The message after exporting names the right folder on Linux.
- This page: a picture of a Linux report, and the README explains all of the above, plus notes for the Steam Deck and for Steam installed as a Flatpak.

## 1.23 - 2026-11-26

**New: a Linux version** (`aGoldenDiagnose.AppImage`), built here from the same code as the Windows one.

- `desktop/linux-helper.js` (new): the Linux side of the watcher. It finds games in Steam, Heroic, Lutris, Bottles, GOG and itch folders, and games run through Proton or Wine by their .exe; reads each game's processor and memory use from `/proc`; reads the graphics card from `nvidia-smi` or, for AMD cards, from `/sys`; reads crashes, graphics-driver resets, out-of-memory kills and hardware and drive errors from the system log (`journalctl`); searches the game's folder, its Proton / Wine prefix and the usual folders in your home folder for the log and crash files of the session; makes the .zip of a report itself. It never attaches to a game, never reads its memory and never asks for administrator rights.
- `desktop/autostart.js` (new): **Start when I sign in** and **Keep alive** on Linux write one file, `~/.config/autostart/aGoldenDiagnose.desktop`, and turning them off deletes it. On Windows nothing changed: it is still the normal Windows login item.
- `desktop/watch.js`: starts the Linux helper on Linux; looks in the Linux places for a game's files; accepts a game's program that isn't an .exe when added by hand; reports made on Linux are marked as such.
- `desktop/pc.js`: **Check my PC** on Linux reads the system name and kernel, whether an update is waiting for a restart, the motherboard and its firmware, and the power profile, all without administrator rights. It says when a drive's own health can't be read (that needs administrator rights on Linux) instead of guessing. It doesn't claim "no blue screens", since Linux keeps no record of past kernel panics that a program can read.
- `desktop/main.js`: **Update** on Linux downloads the new AppImage and puts it in place of the old one.
- `desktop/single.js`: the "already open" message's force-close works on Linux.
- `web/analyze.js`: the reading of a report knows Linux's graphics drivers and system libraries, gives Linux advice (Proton versions, ProtonDB, updating the driver through the distribution) instead of Windows-only advice, and doesn't show an exit code it doesn't have.
- `web/index.html`, `web/diagnose.js`: on Linux the screens use the Linux words (system log, system tray, sign-in), and the Windows-only **Crash dumps…** and **Deep check (as administrator)** buttons are hidden. Text from your own files is never changed.
- `desktop/package.json`: the Linux build (`npm run dist:linux`).

Changed for everyone:

- **Close to the system tray** now starts off like every other switch: closing the window quits the app until you turn it on in Settings. (It was the one switch that started on.)
- `desktop/package.json`: the build no longer tries to make auto-update files it doesn't use.
- This page: the README explains the Linux version, what it reads and writes, and how to build it.

## 1.22 - 2026-11-26

- No change to what the app does.
- Added this changelog. It ships with the source and is shown on every release.
- Releases now list the files that changed since the version before and link to the full differences.

## 1.21 - 2026-11-26

- Settings: the description of **Keep alive** was wrong. It said Windows checks every 3 minutes that the app is running; that was removed in an earlier version. It now says what happens: the app and its helper start each other again if one is ended, and the app opens when you sign in to Windows. The behaviour itself did not change.
- This page: preview pictures added (made with invented games and an invented PC).

## 1.20 - 2026-11-26

- No change to the app.
- This page: the README now also says that a report exported as a .zip goes to `Downloads\aGoldenDiagnose`, that **Update** downloads the new version and replaces the app's own .exe, and how **Keep alive** works.

## 1.19 - 2026-11-26

- The source code is public, and the download is now built by GitHub from that code instead of being uploaded ready-made.
- No change to what the app does.

## 1.18 - 2026-11-26

- First public version.
- Every switch starts off: watching the PC, watching the internet, notifications, watching games from launchers by itself, Keep alive, Start with Windows.
- Updates are checked against this page only, and only when you press **Check for updates**.
