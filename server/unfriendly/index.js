// USER UNFRIENDLY's event app.
//
// npm run unfriendly                 phones join through a free Cloudflare tunnel (needs cloudflared)
// npm run unfriendly -- --lan        phones on the same Wi-Fi join this laptop directly
// npm run unfriendly -- --local      nothing on the network: open http://localhost:3300/?p=1, ?p=2 … as phones
// npm run unfriendly -- --offline    no tunnel, just the host panel (to nudge the clock while phones are off)
// npm run unfriendly -- --preview    a separate copy for trying changes: ports 3310/3311, its own database
// npm run unfriendly -- --fresh      archive this event and start a new one (asks you to type FRESH)
// npm run unfriendly -- --clock      also open the build clock page (it runs without the server)
// Extra: --scale 0.1 makes every duration a tenth (for drills), --db <file>, --ports <phone>,<screen>,
// --no-caffeinate (don't keep the display awake during the build).
//
// Everything is saved as it happens in data/unfriendly/. Stopping the server (Ctrl+C, a crash,
// a flat battery) loses nothing: start it again and it carries on where it was.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { createUnfriendlyServer } from "./server.js";
import { openStore, takeLock, archiveDatabase } from "./store.js";
import { root } from "./net.js";
import { startTunnel } from "../party/tunnel.js";
import { writeClock, keepAwake, openFile, CLOCK_FILE } from "./clock.js";

const argv = process.argv.slice(2);
// Exit code for problems only a person can fix (a bad option, another copy running, a busy port):
// run.js, which restarts the app after a crash, stops instead of trying again.
const NEEDS_A_PERSON = 78;
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const preview = flag("--preview");
const mode = flag("--offline") || preview || flag("--local") ? "local" : flag("--lan") ? "lan" : "tunnel";
const offline = flag("--offline");
const scale = Number(option("--scale") ?? 1);
if (!(scale > 0 && scale <= 10)) {
  console.error("--scale must be a number above 0 (0.1 makes every duration a tenth).");
  process.exit(NEEDS_A_PERSON);
}
const [portA, portB] = (option("--ports") ?? "").split(",").map(Number);
const PHONE_PORT = Number.isInteger(portA) && option("--ports") ? portA : preview ? 3310 : Number(process.env.UNFRIENDLY_PORT) || 3300;
const SCREEN_PORT = Number.isInteger(portB) && option("--ports") ? portB : preview ? 3311 : Number(process.env.UNFRIENDLY_SCREEN_PORT) || 3301;

const DATA_DIR = path.join(root, "data", preview ? "unfriendly-preview" : "unfriendly");
const DB_PATH = option("--db") ? path.resolve(option("--db")) : path.join(DATA_DIR, "unfriendly.db");
const LOCK_PATH = `${DB_PATH}.lock`;

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function inWords(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

// ---------- One copy per database ----------
let releaseLock;
try {
  releaseLock = takeLock(LOCK_PATH);
} catch (err) {
  console.error(err.message);
  process.exit(NEEDS_A_PERSON);
}

// ---------- Starting over ----------
if (flag("--fresh") && fs.existsSync(DB_PATH)) {
  if (!flag("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("This archives the current event and starts a new one. Type FRESH to go on: ");
    rl.close();
    if (answer.trim() !== "FRESH") {
      console.log("Nothing changed.");
      releaseLock();
      process.exit(0);
    }
  }
  const archived = await archiveDatabase(DB_PATH, path.join(path.dirname(DB_PATH), "archive"));
  console.log(`The old event is kept in ${path.relative(root, archived)}.`);
}

let store;
try {
  store = await openStore(DB_PATH, { judgePin: /^\d{4,8}$/.test(process.env.UU_JUDGE_PIN ?? "") ? process.env.UU_JUDGE_PIN : null });
} catch (err) {
  console.error(err.message);
  releaseLock();
  process.exit(NEEDS_A_PERSON);
}
store.run("INSERT INTO boots (at, mode, phase, pid) VALUES (?, ?, ?, ?)", Date.now(), offline ? "offline" : mode, store.getMeta("phase"), process.pid);

const CLOCK_DIR = path.join(path.dirname(DB_PATH), "clock");
const CLOCK_PATH = path.join(CLOCK_DIR, CLOCK_FILE);
// Preview copies and tests don't keep this laptop's screen awake.
const caffeinate = !preview && !flag("--no-caffeinate");

// During the build: the clock page is rewritten and the display kept awake until 15 minutes after
// pencils down. Safe to repeat, so it runs after every host change and on every start.
function buildEffects(ix) {
  if (ix.phase !== "build" || !ix.meta.build_end_at) return;
  writeClock(CLOCK_DIR, ix);
  if (!caffeinate) return;
  const started = keepAwake(ix.meta.build_end_at + 15 * 60_000, store.getMeta("caffeinate"));
  if (started) store.tx(() => store.setMeta("caffeinate", started));
}

const server = createUnfriendlyServer({
  store,
  scale,
  backupDir: path.join(path.dirname(DB_PATH), "backups"),
  onChange: (ix) => buildEffects(ix),
  hostInfo: () => ({ clockFile: fs.existsSync(CLOCK_PATH) ? CLOCK_PATH : null }),
});
try {
  buildEffects(server.ix);
} catch (err) {
  console.error("Couldn't write the clock file:", err.message);
}

let ports;
try {
  ports = await server.listen({ phonePort: PHONE_PORT, phoneHost: mode === "lan" ? "0.0.0.0" : "127.0.0.1", screenPort: SCREEN_PORT });
} catch (err) {
  if (err.code === "EADDRINUSE") console.error(`Port ${err.port} is busy. Is something else running there? Use --ports <phone>,<screen>.`);
  else console.error(err);
  store.close();
  releaseLock();
  process.exit(NEEDS_A_PERSON);
}

// ---------- Where things stand ----------
function report() {
  const ix = server.ix;
  const now = Date.now();
  console.log("");
  console.log(`USER UNFRIENDLY  ·  ${new Date(now).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  console.log(`Phase: ${ix.phase.toUpperCase()}  ·  ${ix.teams.length} of ${ix.maxTeams} teams (up to ${ix.maxSize} each)  ·  ${ix.people.filter((p) => p.role === "participant").length} people  ·  ${ix.pool.length} waiting for a team`);
  if (ix.meta.deal_at) console.log(`Dealt at ${time(ix.meta.deal_at)}`);
  const open = ix.teams.filter((t) => t.swap_until && !t.swapped_at && t.swap_until > now);
  if (open.length) console.log(`Swap windows open: ${open.map((t) => `${t.name} until ${time(t.swap_until)}`).join(", ")}`);
  if (ix.meta.build_end_at) console.log(`Pencils down at ${time(ix.meta.build_end_at)} (${inWords(ix.meta.build_end_at - now)})`);
  if (fs.existsSync(CLOCK_PATH)) console.log(`Clock without the server: ${CLOCK_PATH}  (npm run unfriendly -- --clock opens it)`);
  if (scale !== 1) console.log(`Durations are scaled ×${scale} (a drill).`);
  const shown = path.relative(root, DB_PATH);
  console.log(`Saved in ${shown.startsWith("..") ? DB_PATH : shown}`);
  console.log("");
  console.log(`Big screen:  http://localhost:${ports.screen}`);
  console.log(`Host panel:  http://localhost:${ports.screen}/host`);
}
report();

if (flag("--clock")) {
  if (fs.existsSync(CLOCK_PATH)) openFile(CLOCK_PATH);
  else console.log("There's no clock yet: it's made when the build starts.");
}

let tunnel = null;
if (offline) {
  console.log("Offline: no phones, just the host panel. Ctrl+C when you're done.");
} else if (mode === "tunnel") {
  tunnel = startTunnel(ports.phone, (url, status) => {
    server.setJoin(url, status);
    if (status === "live") console.log(`Phones join at:  ${url}`);
    if (status === "starting") console.log("Starting the Cloudflare tunnel…");
    if (status === "down") console.log("The tunnel stopped. Restarting it with a NEW link: the big screen shows the new QR.");
    if (status === "missing") {
      console.log("cloudflared isn't installed. Install it with:  brew install cloudflared");
      console.log("Or run `npm run unfriendly -- --lan` with phones on the same Wi-Fi.");
    }
  });
} else if (mode === "lan") {
  const ip = lanAddress();
  const url = ip ? `http://${ip}:${ports.phone}` : null;
  server.setJoin(url, "lan");
  console.log(url ? `Phones on this Wi-Fi join at: ${url}` : "No Wi-Fi address found. Is the laptop online?");
} else {
  const url = `http://localhost:${ports.phone}`;
  server.setJoin(url, "off");
  console.log(`Phones: open ${url}/?p=1, ?p=2 … in other windows.`);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  tunnel?.stop();
  await server.close();
  store.close();
  releaseLock();
  console.log("Stopped. Everything is saved; start it again to carry on.");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
