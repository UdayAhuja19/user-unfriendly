// USER UNFRIENDLY's server with real sockets: 80 phones form 20 teams, the host deals, teams
// swap, phones get back in after a new address, and the server is killed (kill -9) and started
// again in the middle without losing anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createUnfriendlyServer } from "../server/unfriendly/server.js";
import { openStore } from "../server/unfriendly/store.js";

function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.messages = [];
    ws.waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      ws.messages.push(msg);
      ws.waiters = ws.waiters.filter((w) => !(w.match(msg) && (w.resolve(msg), true)));
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function next(ws, match, { ms = 5000 } = {}) {
  const seen = ws.messages.find(match);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}`)), ms);
    ws.waiters.push({ match, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
  });
}

// The newest message of a type, once it matches.
async function until(ws, t, check = () => true, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const msg = [...ws.messages].reverse().find((m) => m.t === t);
    if (msg && check(msg)) return msg;
    if (Date.now() > end) throw new Error(`timed out waiting for ${t}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
let opSeq = 0;
const op = () => `op-${String((opSeq += 1)).padStart(6, "0")}`;

// Sends an action and waits for its answer.
async function act(ws, msg) {
  const id = op();
  const waiting = next(ws, (m) => m.op === id);
  send(ws, { ...msg, op: id });
  return waiting;
}

async function phone(url, cid) {
  const ws = await open(url);
  send(ws, { t: "hello", cid });
  await next(ws, (m) => m.t === "who" || m.t === "view");
  return ws;
}

async function boot(file = ":memory:") {
  const store = await openStore(file);
  const server = createUnfriendlyServer({ store, tickMs: 20 });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const phoneUrl = `ws://127.0.0.1:${ports.phone}/ws`;
  const host = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  send(host, { t: "hello", role: "host" });
  const screen = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  send(screen, { t: "hello", role: "screen" });
  const run = async (t, payload = {}) => {
    const id = op();
    const waiting = next(host, (m) => m.t === "result" && m.op === id);
    send(host, { t, op: id, ...payload });
    return waiting;
  };
  return { store, server, ports, phoneUrl, host, screen, run, close: async () => (await server.close(), store.close()) };
}

test("80 phones make 20 teams, the host deals, teams swap, and the big screen never shows a code", { timeout: 30_000 }, async () => {
  const app = await boot();
  try {
    assert.ok((await app.run("settings", { maxTeams: 20, maxSize: 4 })).ok);
    const makers = await Promise.all(Array.from({ length: 20 }, (_, i) => phone(app.phoneUrl, `maker-${String(i).padStart(4, "0")}`)));
    const made = await Promise.all(makers.map((ws, i) => act(ws, { t: "make", name: `Maker ${i}`, team: `Team ${i}` })));
    assert.ok(made.every((m) => m.t === "ok"), JSON.stringify(made.find((m) => m.t !== "ok")));
    const codes = await Promise.all(makers.map((ws) => until(ws, "view", (m) => m.view.team).then((m) => m.view.team.code)));
    assert.equal(new Set(codes).size, 20);

    const joiners = await Promise.all(Array.from({ length: 60 }, (_, i) => phone(app.phoneUrl, `joiner-${String(i).padStart(4, "0")}`)));
    const joined = await Promise.all(joiners.map((ws, i) => act(ws, { t: "join", name: `Joiner ${i}`, code: codes[i % 20] })));
    assert.ok(joined.every((m) => m.t === "ok"));
    const extra = await phone(app.phoneUrl, "extra-00000001");
    assert.match((await act(extra, { t: "join", name: "One Too Many", code: codes[0] })).error, /IS FULL \(4\)/);
    assert.match((await act(extra, { t: "make", name: "One Too Many", team: "Twenty One" })).error, /ALL 20 TEAMS ARE MADE/);

    // A phone can't run the host's commands.
    for (const t of ["deal", "settings", "buildStart", "person", "group"]) send(extra, { t, op: op(), maxTeams: 1 });

    assert.ok((await app.run("deal")).ok);
    const views = await Promise.all([...makers, ...joiners].map((ws) => until(ws, "view", (m) => m.view.team?.cards.length === 1)));
    for (const v of views) assert.equal(v.view.team.cards.length, 1);
    const state = await until(app.screen, "state", (m) => m.phase === "deal");
    for (const code of codes) assert.ok(!JSON.stringify(state).includes(code), "no team code on the big screen");

    // Swaps: one per team, the second teammate gets "already".
    const swapped = await act(makers[0], { t: "swap", slot: 0 });
    assert.equal(swapped.t, "ok");
    const again = await act(joiners[0], { t: "swap", slot: 0 }); // joiner 0 is in team 0
    assert.equal(again.t, "ok");
    const team0 = (await until(joiners[0], "view", (m) => m.view.team.swapped)).view.team;
    assert.equal(team0.swapped, true);
    assert.equal(team0.canSwap, false);

    // Getting back in on "a new address": a fresh id, the team code, then tap your name.
    const lost = await phone(app.phoneUrl, "new-address-0001");
    const lookup = await act(lost, { t: "lookup", code: codes[3].toLowerCase() });
    assert.equal(lookup.t, "found");
    const me = lookup.team.members.find((m) => m.name === "Maker 3");
    const busy = await act(lost, { t: "claim", personId: me.id, code: codes[3] });
    assert.equal(busy.elsewhere, true, "Maker 3 is still online on the old phone");
    const closed = new Promise((resolve) => makers[3].once("close", (code) => resolve(code)));
    assert.equal((await act(lost, { t: "claim", personId: me.id, code: codes[3], force: true })).t, "ok");
    assert.equal(await closed, 4001, "the old phone is told it moved");
    const view = await until(lost, "view", (m) => m.view.you?.name === "Maker 3");
    assert.equal(view.view.team.code, codes[3]);

    // Wrong codes: five and the socket is closed.
    const guesser = await phone(app.phoneUrl, "guesser-0000001");
    const gone = new Promise((resolve) => guesser.once("close", (code) => resolve(code)));
    for (let i = 0; i < 5; i += 1) send(guesser, { t: "lookup", code: "XXXX", op: op() });
    assert.equal(await gone, 1008);

    for (const ws of [...makers, ...joiners, extra, lost]) ws.close();
  } finally {
    await app.close();
  }
});

test("the big screen port only talks to this laptop, and only the host page runs the event", async () => {
  const app = await boot();
  try {
    const status = (host, port) =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode))).on("error", reject);
      });
    assert.equal(await status(`localhost:${app.ports.screen}`, app.ports.screen), 200);
    assert.equal(await status(`evil.example:${app.ports.screen}`, app.ports.screen), 403);
    assert.equal(await status(`anything.trycloudflare.com`, app.ports.phone), 200, "the phone port is public");
    await assert.rejects(open(`ws://127.0.0.1:${app.ports.screen}/ws`, { origin: "https://evil.example" }));
    // The big screen's own page (role "screen") can't run commands either.
    send(app.screen, { t: "deal", op: op() });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.server.ix.phase, "join");
  } finally {
    await app.close();
  }
});

// ---------- kill -9 and start again ----------
function startServer(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/unfriendly/index.js", "--local", "--no-caffeinate", "--db", db, "--ports", "0,0"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const screen = out.match(/Big screen:\s+http:\/\/localhost:(\d+)/);
      const phonePort = out.match(/Phones: open http:\/\/localhost:(\d+)/);
      if (screen && phonePort) {
        clearTimeout(timer);
        resolve({ child, screenPort: Number(screen[1]), phonePort: Number(phonePort[1]), out: () => out });
      }
    });
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => code && reject(new Error(`server exited ${code}: ${out}`)));
  });
}

async function hostOf(screenPort) {
  const host = await open(`ws://127.0.0.1:${screenPort}/ws`, { origin: `http://127.0.0.1:${screenPort}` });
  send(host, { t: "hello", role: "host" });
  const run = async (t, payload = {}) => {
    const id = op();
    const waiting = next(host, (m) => m.t === "result" && m.op === id);
    send(host, { t, op: id, ...payload });
    return waiting;
  };
  return { host, run };
}

test("kill -9 at any moment: the server starts again exactly where it was", { timeout: 40_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uu-resume-"));
  const db = path.join(dir, "event.db");

  // ---- Teams made, then killed ----
  let s = await startServer(db);
  let { host, run } = await hostOf(s.screenPort);
  const a = await phone(`ws://127.0.0.1:${s.phonePort}/ws`, "phone-aaaaaaaa");
  const b = await phone(`ws://127.0.0.1:${s.phonePort}/ws`, "phone-bbbbbbbb");
  assert.equal((await act(a, { t: "make", name: "Aisha", team: "Alpha" })).t, "ok");
  const code = (await until(a, "view", (m) => m.view.team)).view.team.code;
  assert.equal((await act(b, { t: "join", name: "Ben", code })).t, "ok");
  s.child.kill("SIGKILL");
  await new Promise((r) => s.child.once("exit", r));

  // ---- Started again (on new ports: a new address). The same phone ids are still them. ----
  s = await startServer(db);
  ({ host, run } = await hostOf(s.screenPort));
  let a2 = await phone(`ws://127.0.0.1:${s.phonePort}/ws`, "phone-aaaaaaaa");
  let view = (await until(a2, "view")).view;
  assert.equal(view.team.name, "Alpha");
  assert.deepEqual(view.team.members.map((m) => m.name).sort(), ["Aisha", "Ben"]);

  // ---- Dealt, killed in the swap window ----
  assert.ok((await run("deal")).ok);
  const dealt = (await until(a2, "view", (m) => m.view.team.cards.length === 1)).view.team;
  s.child.kill("SIGKILL");
  await new Promise((r) => s.child.once("exit", r));

  s = await startServer(db);
  ({ host, run } = await hostOf(s.screenPort));
  a2 = await phone(`ws://127.0.0.1:${s.phonePort}/ws`, "phone-aaaaaaaa");
  view = (await until(a2, "view")).view;
  assert.deepEqual(view.team.cards, dealt.cards, "the same cards");
  assert.equal(view.team.swapUntil, dealt.swapUntil, "the same swap deadline");
  assert.equal(view.team.canSwap, true);
  assert.equal((await act(a2, { t: "swap", slot: 0 })).t, "ok");

  // ---- Build started, killed: the end time survives ----
  assert.ok((await run("buildStart", { minutes: 55 })).ok);
  const build = (await until(a2, "view", (m) => m.view.phase === "build")).view.build;
  s.child.kill("SIGKILL");
  await new Promise((r) => s.child.once("exit", r));

  s = await startServer(db);
  assert.match(s.out(), /Phase: BUILD/);
  assert.match(s.out(), /Pencils down at/);
  const clockFile = path.join(dir, "clock", "USER-UNFRIENDLY-CLOCK.html");
  assert.ok(fs.readFileSync(clockFile, "utf8").includes(String(build.endAt)), "the clock page is there, with the same end time");
  ({ host } = await hostOf(s.screenPort));
  const hostView = await until(host, "host");
  assert.equal(hostView.phase, "build");
  assert.equal(hostView.build.endAt, build.endAt);
  assert.equal(hostView.teams[0].replaced.length, 1, "the swap is remembered");
  s.child.kill("SIGINT");
  await new Promise((r) => s.child.once("exit", r));
});

test("npm run unfriendly restarts the app after a crash, without --fresh, and loses nothing", { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uu-run-"));
  const db = path.join(dir, "uu.db");
  const base = 3500 + Math.floor(Math.random() * 400) * 2;
  const sup = spawn(process.execPath, ["server/unfriendly/run.js", "--local", "--fresh", "--yes", "--db", db, "--ports", `${base},${base + 1}`, "--no-caffeinate"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  sup.stdout.on("data", (d) => (out += d));
  sup.stderr.on("data", (d) => (out += d));
  const waitFor = async (check, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; output:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await waitFor(() => (out.match(/Big screen:/g) ?? []).length >= 1);
    const ws = new WebSocket(`ws://127.0.0.1:${base}/ws`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ t: "hello", cid: "crash-test-01" }));
    ws.send(JSON.stringify({ t: "make", op: "make-crash-1", name: "Crash Test", team: "Survivors" }));
    await new Promise((r) => ws.on("message", (d) => JSON.parse(d).op === "make-crash-1" && r()));
    ws.terminate();
    const appPid = Number(fs.readFileSync(`${db}.lock`, "utf8"));
    process.kill(appPid, "SIGKILL");
    await waitFor(() => (out.match(/Big screen:/g) ?? []).length >= 2);
    assert.match(out, /stopped unexpectedly \(SIGKILL\)/);
    assert.equal(fs.readdirSync(dir).includes("archive"), false, "the restart didn't start a fresh event");
    const store = await openStore(db);
    assert.deepEqual(store.all("SELECT name FROM teams").map((t) => t.name), ["Survivors"]);
    store.close();
  } finally {
    sup.kill("SIGTERM");
    await new Promise((r) => sup.once("exit", r));
  }
});
