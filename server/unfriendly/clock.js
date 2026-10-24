// The build clock that needs no server. At START BUILD (and after every nudge, and on every
// start-up during the build) a self-contained page is written next to the database: fonts and
// data inside it, so it opens by double-click, keeps counting through a reload, and can be
// AirDropped to another laptop. A small clock-state.js beside it carries later nudges to a page
// that's already open. caffeinate keeps the display awake until the end, even after Ctrl+C.
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { root } from "./net.js";
import { feature } from "./deck.js";

export const CLOCK_FILE = "USER-UNFRIENDLY-CLOCK.html";
const font = (name) => fs.readFileSync(path.join(root, "unfriendly/brand/fonts", name)).toString("base64");
// JSON inside a <script>: nothing in a team name can end the script.
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (ch) => (ch === "\u2028" ? "\\u2028" : "\\u2029"));

export function clockState(ix) {
  return {
    eventId: ix.meta.event_id,
    buildId: ix.meta.build_start_at,
    version: ix.meta.clock_version ?? 1,
    startAt: ix.meta.build_start_at,
    endAt: ix.meta.build_end_at,
    teams: ix.teams.map((t) => ({ name: t.name, cards: t.dealt_at === null ? [] : t.cards.map((id) => feature(id)?.name ?? id) })),
  };
}

function page(state) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>USER UNFRIENDLY · Build clock</title>
<style>
@font-face { font-family: "Archivo"; src: url(data:font/woff2;base64,${font("archivo-latin-wdth-normal.woff2")}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
@font-face { font-family: "DM Mono"; src: url(data:font/ttf;base64,${font("DMMono-Regular.ttf")}) format("truetype"); }
:root { --red: #E5231B; --ink: #0D0D0D; --paper: #F2EEE6; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; color: var(--ink); background: var(--paper); font-family: "Archivo", sans-serif; }
body { display: grid; grid-template-rows: auto auto 1fr; gap: 2.4vh; padding: 2.2vh 3vw 3vh; }
.top { display: flex; justify-content: space-between; font-family: "DM Mono", monospace; font-size: max(12px, 1.05vw); letter-spacing: 0.14em; text-transform: uppercase; }
.clock { display: flex; align-items: end; justify-content: space-between; gap: 3vw; padding: 1.6vh 2vw 1.4vh; color: var(--paper); background: var(--red); }
.time { font-weight: 900; font-stretch: 62%; font-size: min(22vh, 16vw); line-height: 0.8; font-variant-numeric: tabular-nums; }
.label { display: grid; gap: 1vh; text-align: right; font-weight: 800; font-size: max(14px, 1.4vw); text-transform: uppercase; }
.label b { font-weight: 900; font-stretch: 70%; font-size: 2.4em; line-height: 0.9; }
.wall { min-height: 0; overflow: hidden; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(16vw, 220px), 1fr)); grid-auto-rows: min-content; gap: 1.4vh 1.2vw; align-content: start; }
.team { display: grid; align-content: start; gap: 0.6vh; padding: 1vh 0.8vw; border: 3px solid var(--ink); container-type: inline-size; }
.name { margin: 0; font-weight: 900; font-stretch: 75%; font-size: clamp(14px, 11cqi, 26px); line-height: 0.95; text-transform: uppercase; overflow-wrap: anywhere; }
.card { padding: 0.5vh 0.5vw 0.4vh; color: var(--paper); background: var(--ink); font-weight: 900; font-stretch: 80%; font-size: clamp(12px, 9cqi, 22px); line-height: 1; text-transform: uppercase; }
.down { position: fixed; inset: 0; display: none; place-content: center; text-align: center; color: var(--paper); background: var(--red); }
.down h1 { margin: 0; font-weight: 900; font-stretch: 62%; font-size: min(26vh, 15vw); line-height: 0.82; text-transform: uppercase; }
.down p { margin: 3vh 0 0; font-weight: 900; font-stretch: 75%; font-size: max(20px, 3vw); text-transform: uppercase; }
.over { position: fixed; right: 2vw; bottom: 2vh; font-family: "DM Mono", monospace; font-size: 14px; }
body.ended .down { display: grid; }
</style></head>
<body>
<div class="top"><span>GDG on Campus UOBD × Computing Club</span><span>Build clock · F: full screen</span></div>
<div class="clock"><span class="time" id="time">–:––</span><span class="label">Pencils down at<b id="end"></b></span></div>
<div class="wall" id="wall"></div>
<div class="down"><h1>Pencils<br>down</h1><p>Bring your chairs to the centre</p><span class="over" id="over"></span></div>
<script>
let state = ${safeJson(state)};
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
function clock(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ":" + pad(Math.floor(s % 3600 / 60)) : Math.floor(s / 60)) + ":" + pad(s % 60); }
function drawTeams() {
  $("end").textContent = new Date(state.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  $("wall").replaceChildren(...state.teams.map((t) => {
    const el = document.createElement("article"); el.className = "team";
    const n = document.createElement("p"); n.className = "name"; n.textContent = t.name; el.append(n);
    for (const c of t.cards) { const s = document.createElement("span"); s.className = "card"; s.textContent = c; el.append(s); }
    return el;
  }));
  const wall = $("wall");
  for (const min of [220, 190, 165, 145, 125, 110, 96, 84]) { wall.style.gridTemplateColumns = "repeat(auto-fill, minmax(min(16vw, " + min + "px), 1fr))"; if (wall.scrollHeight <= wall.clientHeight + 1) break; }
}
// Every tick from the end time and this laptop's clock: right straight after a sleep or a reload.
function tick() {
  const left = state.endAt - Date.now();
  $("time").textContent = clock(left);
  document.body.classList.toggle("ended", left <= 0);
  $("over").textContent = left <= 0 ? "+" + clock(-left) : "";
}
// A nudge made with the server running reaches this open page through clock-state.js.
window.__uuClock = (next) => { if (next && next.eventId === state.eventId && next.buildId === state.buildId && next.version > state.version) { state = next; drawTeams(); tick(); } };
setInterval(() => { const s = document.createElement("script"); s.src = "clock-state.js?r=" + Date.now(); s.onload = s.onerror = () => s.remove(); document.head.append(s); }, 5000);
document.addEventListener("keydown", (e) => { if (e.key === "f" || e.key === "F") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); });
navigator.wakeLock?.request("screen").catch(() => {});
document.fonts.ready.then(drawTeams); drawTeams(); tick(); setInterval(tick, 250);
</script>
</body></html>
`;
}

function writeAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

// Writes (or rewrites) the clock page and its state file. Returns the page's path.
export function writeClock(dir, ix) {
  fs.mkdirSync(dir, { recursive: true });
  const state = clockState(ix);
  const file = path.join(dir, CLOCK_FILE);
  writeAtomic(file, page(state));
  writeAtomic(path.join(dir, "clock-state.js"), `window.__uuClock && window.__uuClock(${safeJson(state)});\n`);
  return file;
}

function isCaffeinate(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim().endsWith("caffeinate");
  } catch {
    return false;
  }
}

// Keeps the display awake until `untilMs`. Detached, so Ctrl+C on the server doesn't stop it.
// Returns the new { pid, until } or null when nothing needed starting.
export function keepAwake(untilMs, current, { now = Date.now(), spawn = nodeSpawn } = {}) {
  if (untilMs <= now) return null;
  if (current && isCaffeinate(current.pid) && current.until >= untilMs) return null;
  try {
    const child = spawn("caffeinate", ["-d", "-i", "-t", String(Math.ceil((untilMs - now) / 1000))], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
    return child.pid ? { pid: child.pid, until: untilMs } : null;
  } catch {
    return null; // Not a Mac: the screen's own settings will have to do.
  }
}

export function openFile(file) {
  const child = nodeSpawn("open", ["-a", "Google Chrome", file], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
