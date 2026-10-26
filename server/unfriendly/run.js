// npm run unfriendly runs this: it starts the app (index.js) and, if the app ever crashes, starts it
// again two seconds later. Nothing is lost by a crash: every change is in the database before anyone
// is told about it, and the app carries on from the database (the tests kill it with SIGKILL to prove it).
//
// - Ctrl+C stops everything, as before (the app saves and exits cleanly; nothing restarts).
// - --fresh (and --yes, --clock) only apply to the first start, so a crash never starts a new event.
// - Problems only a person can fix (another copy running, a busy port, a bad option) aren't retried.
// - More than 5 crashes in a minute: it stops and says so, rather than looping.
// - --no-restart runs the app on its own, without this.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const NEEDS_A_PERSON = 78;
const FIRST_START_ONLY = new Set(["--fresh", "--yes", "--clock"]);
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;
const RESTART_AFTER_MS = 2_000;

let args = process.argv.slice(2);
let child = null;
let stopping = false;
const crashes = [];

function start() {
  child = spawn(process.execPath, [APP, ...args.filter((a) => a !== "--no-restart")], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping || code === 0 || code === NEEDS_A_PERSON || args.includes("--no-restart")) process.exit(code ?? 0);
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    console.error("");
    if (crashes.length > MAX_CRASHES) {
      console.error(`The app crashed ${crashes.length} times in a minute, so it isn't restarting by itself. Everything is saved.`);
      console.error("Run  npm run unfriendly  again (never --fresh) once the problem is fixed, or call Uday.");
      process.exit(1);
    }
    console.error(`!! The app stopped unexpectedly (${signal ?? `exit code ${code}`}). Starting it again in 2 seconds.`);
    console.error("!! Nothing is lost: it carries on exactly where it was. The phones' link will change; the big screen shows the new QR.");
    args = args.filter((a) => !FIRST_START_ONLY.has(a));
    setTimeout(start, RESTART_AFTER_MS);
  });
}

// Ctrl+C reaches the app too (same terminal), and it stops cleanly by itself; just don't restart it.
// Other stop signals are passed on. If the app hasn't stopped in 10 seconds, it's forced.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    if (sig !== "SIGINT") child.kill(sig);
    setTimeout(() => child?.kill("SIGKILL"), 10_000).unref();
  });
}

start();
