// USER UNFRIENDLY: two small web servers sharing one event, like PICTIONARY.
//
//   phone port  (tunnelled): participants make and join teams, see their cards, swap one
//   screen port (this laptop only): the big screen ("/") and the host panel ("/host")
//
// Every change goes the same way: check it, write it to the database in one transaction, then
// tell people. So the event is always exactly what's on disk, and a restart loses nothing.
// Messages are small JSON objects with a "t" field.
import http from "node:http";
import { WebSocketServer } from "ws";
import * as cmd from "./commands.js";
import * as show from "./show.js";
import { index, whoView, participantView, audienceView, judgeView, screenView, hostView, hasPresented } from "./event.js";
import { winnersCsv, participantsCsv, judgesCsv } from "./results.js";
import { webApp, isLocalHost, send, listen, bucket, take, safely } from "./net.js";
import { pixelQr } from "./qr.js";

// Phones answer every ping; one that's silent this long is gone even if the socket never closed.
const PING_EVERY_MS = 2000;
const DEAD_AFTER_MS = 12_000;
const HELLO_TIMEOUT_MS = 60_000;
const TICK_MS = 100;
// Views are checked every second anyway, so a deadline passing (a swap window closing) shows up.
const REFRESH_EVERY_MS = 1000;
const SCREEN_EVERY_MS = 250;
const SCREEN_HEARTBEAT_MS = 1000;
const BACKUP_EVERY_MS = 2 * 60_000;
// Sticker piles go to the phones looking at that team, in batches.
const PILE_EVERY_MS = 500;
const PILE_SNAPSHOT = 200;
// A pasted link can be long (Figma, Canva); everything else is far smaller.
const PHONE_MAX_BYTES = 1024;
const SCREEN_MAX_BYTES = 8192;
const MESSAGES_PER_SEC = 20;
const MESSAGE_BURST = 60;
const MAX_PHONE_SOCKETS = 300;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const OP_ID = /^[A-Za-z0-9-]{6,40}$/;
// Wrong team codes or names: a few per phone, and not many per second from everyone together.
const WRONG_PER_SOCKET = 5;
const GUESSES_PER_SEC = 2;
const GUESS_BURST = 20;

const HOST_COMMANDS = {
  settings: cmd.settings,
  group: cmd.group,
  deal: cmd.deal,
  undoDeal: cmd.undoDeal,
  reopenSwap: cmd.reopenSwap,
  buildStart: cmd.buildStart,
  nudge: cmd.nudge,
  person: cmd.editPerson,
  team: cmd.editTeam,
  linksOpen: show.linksOpen,
  linksExtend: show.linksExtend,
  hostLink: show.hostLink,
  presentStart: show.presentStart,
  demoStart: show.demoStart,
  next: show.next,
  toEnd: show.toEnd,
  demoLength: show.setDemoLength,
  resultsStart: show.resultsStart,
  reveal: show.reveal,
};

// The full export may be shared (events team, certificates), so it never carries the judges' PIN.
const everythingButThePin = (data) => ({ ...data, meta: { ...data.meta, judge_pin: undefined } });

export function createUnfriendlyServer({ store, clock = Date.now, random = Math.random, scale = 1, tickMs = TICK_MS, pingEveryMs = PING_EVERY_MS, backupDir = null, onPhase = null, onChange = null, hostInfo = () => ({}) } = {}) {
  let ix = index(store.load());
  const personSocket = new Map(); // personId -> the phone socket that is them right now
  const screens = new Set();
  let join = { url: null, qr: null, tunnel: "off" };
  let phonesDirty = true;
  let screenDirty = true;
  let lastScreenAt = 0;
  let lastRefreshAt = 0;
  let timers = [];
  const guesses = bucket(GUESSES_PER_SEC, GUESS_BURST, clock());

  const ctx = () => ({ store, ix, now: clock(), random, scale });
  const online = () => new Set(personSocket.keys());

  function refresh() {
    ix = index(store.load());
    phonesDirty = true;
    screenDirty = true;
  }

  const phoneHttp = http.createServer(webApp({ pages: { "/": "phone.html", "/judge": "judge.html" }, localOnly: false }));
  const screenHttp = http.createServer(webApp({ pages: { "/": "screen.html", "/host": "host.html" }, localOnly: true, routes: exportRoutes }));

  // The certificate lists, on this laptop only.
  function exportRoutes(app) {
    const presented = () => new Set(ix.teams.filter((t) => hasPresented(ix, t.id)).map((t) => t.id));
    const sendCsv = (res, name, text) => res.attachment(name).type("text/csv; charset=utf-8").send(text);
    app.get("/export/winners.csv", (req, res) => (ix.meta.results_json ? sendCsv(res, "user-unfriendly-winners.csv", winnersCsv(ix.meta.results_json)) : res.status(409).type("text").send("THE RESULTS HAVEN'T STARTED.")));
    app.get("/export/participants.csv", (req, res) => sendCsv(res, "user-unfriendly-participants.csv", participantsCsv(ix, presented())));
    app.get("/export/judges.csv", (req, res) => sendCsv(res, "user-unfriendly-judges.csv", judgesCsv(ix)));
    app.get("/export/everything.json", (req, res) => res.attachment("user-unfriendly-everything.json").json({ ...everythingButThePin(store.load()), stickers: store.all("SELECT * FROM stickers"), audit: store.all("SELECT * FROM audit ORDER BY id") }));
  }
  const phoneWss = new WebSocketServer({ server: phoneHttp, path: "/ws", maxPayload: PHONE_MAX_BYTES });
  const screenWss = new WebSocketServer({
    server: screenHttp,
    path: "/ws",
    maxPayload: SCREEN_MAX_BYTES,
    // Only the big screen and host pages themselves may connect, not some other page in the browser.
    verifyClient: ({ origin, req }) => {
      if (!isLocalHost(req.headers.host)) return false;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });
  // Without these, a port that's already taken crashes the process before index.js can explain it.
  phoneWss.on("error", () => {});
  screenWss.on("error", () => {});

  // ---------- Phones ----------
  // How many of each side-quest sticker this person has stuck (only while stickers are on).
  function used(personId) {
    if (ix.phase !== "present") return {};
    return Object.fromEntries(store.all("SELECT kind, COUNT(*) AS n FROM stickers WHERE person_id = ? AND quest = 1 AND removed_at IS NULL GROUP BY kind", personId).map((r) => [r.kind, r.n]));
  }

  function viewMessage(conn, now, people = online()) {
    if (conn.personId !== null) {
      const person = ix.personById.get(conn.personId);
      if (person?.role === "judge") return { t: "view", view: judgeView(ix, person, now) };
      if (person?.role === "audience") return { t: "view", view: audienceView(ix, person, now, used(person.id)) };
      if (person) return { t: "view", view: participantView(ix, person, now, people, used(person.id)) };
    }
    return { t: "who", view: whoView(ix, now) };
  }

  // Sends this phone its view if it changed (the server time alone doesn't count as a change).
  function sendView(ws, now, people, force = false) {
    const msg = viewMessage(ws.conn, now, people);
    const key = JSON.stringify({ ...msg, view: { ...msg.view, serverNow: 0 } });
    if (!force && key === ws.conn.lastKey) return;
    ws.conn.lastKey = key;
    send(ws, msg);
  }

  function flushPhones(now) {
    phonesDirty = false;
    const people = online();
    for (const ws of phoneWss.clients) if (ws.conn?.cid) sendView(ws, now, people);
  }

  // This socket is now that person. Another socket that was them (an old tab, another phone)
  // is told so and closed.
  function bind(ws, personId) {
    const old = personSocket.get(personId);
    if (old && old !== ws) {
      old.conn.personId = null;
      old.close(4001, "moved");
    }
    if (ws.conn.personId !== null && ws.conn.personId !== personId && personSocket.get(ws.conn.personId) === ws) personSocket.delete(ws.conn.personId);
    ws.conn.personId = personId;
    personSocket.set(personId, ws);
    phonesDirty = true;
    screenDirty = true;
  }

  function hello(ws, now) {
    const row = store.get("SELECT p.id FROM devices d JOIN people p ON p.id = d.person_id WHERE d.client_id = ? AND p.removed_at IS NULL", ws.conn.cid);
    if (row) {
      bind(ws, row.id);
      store.run("UPDATE devices SET last_seen = ? WHERE client_id = ?", now, ws.conn.cid);
    }
    send(ws, { t: "hi", serverNow: now, eventId: ix.meta.event_id });
    sendView(ws, now, online(), true);
  }

  function wrong(ws) {
    ws.conn.wrong += 1;
    if (ws.conn.wrong >= WRONG_PER_SOCKET) ws.close(1008, "too many tries");
  }

  // A phone action: run it, and only if it was written, tell the phone and everyone else.
  function act(ws, msg, run) {
    if (typeof msg.op !== "string" || !OP_ID.test(msg.op)) return;
    const conn = ws.conn;
    const me = conn.personId === null ? null : ix.personById.get(conn.personId) ?? null;
    const result = run(ctx(), me);
    if (result.error) {
      if (result.wrongCode) wrong(ws);
      send(ws, { t: "no", op: msg.op, error: result.error, elsewhere: result.elsewhere ?? false });
      return;
    }
    refresh();
    if (result.personId) bind(ws, result.personId);
    send(ws, { t: "ok", op: msg.op });
    sendView(ws, clock(), online(), true);
  }

  // Looking for a team code or a name: limited, so nobody can try every code.
  function guess(ws, msg, run) {
    if (typeof msg.op !== "string" || !OP_ID.test(msg.op)) return;
    if (!take(guesses, clock())) return send(ws, { t: "no", op: msg.op, error: "TOO MANY TRIES. WAIT A MOMENT AND TRY AGAIN." });
    const result = run(ctx());
    if (result.error) {
      if (result.wrongCode) wrong(ws);
      return send(ws, { t: "no", op: msg.op, error: result.error });
    }
    send(ws, { t: "found", op: msg.op, ...result });
  }

  function handlePhone(ws, msg) {
    const conn = ws.conn;
    const now = clock();
    if (msg.t === "hello") {
      if (typeof msg.cid !== "string" || !CLIENT_ID.test(msg.cid)) return send(ws, { t: "error", message: "RELOAD THE PAGE AND TRY AGAIN." });
      if (conn.cid && conn.cid !== msg.cid) return;
      conn.cid = msg.cid;
      return hello(ws, now);
    }
    if (!conn.cid) return;
    const input = (keys) => Object.fromEntries(keys.map((k) => [k, msg[k]]));
    switch (msg.t) {
      case "pong":
        return;
      case "sync":
        if (Number.isFinite(msg.c)) send(ws, { t: "sync", c: msg.c, s: now });
        return;
      case "make":
        return act(ws, msg, (c, me) => cmd.make(c, me, conn.cid, input(["name", "team"])));
      case "join":
        return act(ws, msg, (c, me) => cmd.join(c, me, conn.cid, input(["name", "code"])));
      case "pool":
        return act(ws, msg, (c, me) => cmd.pool(c, me, conn.cid, input(["name"])));
      case "rename":
        return act(ws, msg, (c, me) => cmd.rename(c, me, conn.cid, input(["team"])));
      case "leave":
        return act(ws, msg, (c, me) => cmd.leave(c, me, conn.cid));
      case "swap":
        return act(ws, msg, (c, me) => cmd.swap(c, me, conn.cid, input(["slot"])));
      case "lookup":
        return guess(ws, msg, (c) => cmd.lookup(c, input(["code"])));
      case "find":
        return guess(ws, msg, (c) => cmd.findByName(c, input(["name"])));
      case "link":
        return act(ws, msg, (c, me) => show.link(c, me, conn.cid, input(["code", "url"])));
      case "judges":
        return guess(ws, msg, (c) => show.judgeList(c, input(["pin"])));
      case "judgeNew":
        return act(ws, msg, (c, me) => show.judgeNew(c, me, conn.cid, input(["pin", "name"])));
      case "rate":
        return act(ws, msg, (c, me) => show.rate(c, me, conn.cid, input(["team", "value"])));
      case "audience":
        return act(ws, msg, (c, me) => show.audience(c, me, conn.cid, input(["name", "ownTeam"])));
      case "slap":
      case "move":
      case "peel":
        return sticker(ws, msg);
      case "watch":
        return watch(ws, msg.team);
      case "judgeClaim":
      case "claim": {
        if (!Number.isInteger(msg.personId)) return;
        // Already open on another phone: ask first, so nobody kicks a teammate out by mistake.
        const other = personSocket.get(msg.personId);
        if (other && other !== ws && msg.force !== true) {
          return send(ws, { t: "no", op: msg.op, error: "THIS NAME IS OPEN ON ANOTHER PHONE.", elsewhere: true });
        }
        if (msg.t === "judgeClaim") return act(ws, msg, (c) => show.judgeClaim(c, conn.cid, { pin: msg.pin, personId: msg.personId }));
        const proof = msg.code !== undefined ? { code: msg.code } : { name: msg.name };
        return act(ws, msg, (c) => cmd.claim(c, conn.cid, { personId: msg.personId, ...proof }));
      }
      default:
    }
  }

  // ---------- Stickers ----------
  const watchers = new Map(); // teamId -> Set of sockets showing that team's card
  const pileChanges = new Map(); // teamId -> { add: [], del: [] } waiting to go out

  function queue(teamId, kind, item) {
    if (!pileChanges.has(teamId)) pileChanges.set(teamId, { add: [], del: [] });
    pileChanges.get(teamId)[kind].push(item);
  }

  function unwatch(ws) {
    if (ws.conn.watching !== undefined) watchers.get(ws.conn.watching)?.delete(ws);
    ws.conn.watching = undefined;
  }

  // A phone shows a team's card: it gets the pile (newest first) and then the changes.
  function watch(ws, teamId) {
    unwatch(ws);
    if (!Number.isInteger(teamId) || !ix.teamById.has(teamId)) return;
    ws.conn.watching = teamId;
    if (!watchers.has(teamId)) watchers.set(teamId, new Set());
    watchers.get(teamId).add(ws);
    const rows = store.all("SELECT id, kind, x, y, person_id FROM stickers WHERE team_id = ? AND removed_at IS NULL ORDER BY id DESC LIMIT ?", teamId, PILE_SNAPSHOT);
    send(ws, { t: "pile", team: teamId, stickers: rows.map((r) => [r.id, r.kind, r.x, r.y, r.person_id]) });
  }

  function flushPiles() {
    for (const [teamId, change] of pileChanges) {
      const msg = JSON.stringify({ t: "pile+", team: teamId, add: change.add, del: change.del });
      for (const ws of watchers.get(teamId) ?? []) if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    pileChanges.clear();
  }

  function sticker(ws, msg) {
    if (typeof msg.op !== "string" || !OP_ID.test(msg.op)) return;
    const me = ws.conn.personId === null ? null : ix.personById.get(ws.conn.personId) ?? null;
    const input = { op: msg.op, id: msg.id, team: msg.team, kind: msg.kind, x: msg.x, y: msg.y };
    const result = show[msg.t](ctx(), me, ws.conn.cid, input);
    if (result.error) return send(ws, { t: "no", op: msg.op, error: result.error });
    const s = result.sticker;
    if (s) queue(s.team, "add", [s.id, s.kind, s.x, s.y, s.by]);
    if (result.moved) {
      const m = result.moved;
      queue(m.from, "del", m.id);
      queue(m.team, "add", [m.id, m.kind, m.x, m.y, m.by]);
    }
    if (result.peeled) queue(result.peeled.team, "del", result.peeled.id);
    send(ws, { t: "ok", op: msg.op, id: s?.id ?? null });
    sendView(ws, clock(), online());
    screenDirty = true;
  }

  phoneWss.on("connection", (ws) => {
    const now = clock();
    ws.conn = { cid: null, personId: null, openedAt: now, lastHeard: now, limit: bucket(MESSAGES_PER_SEC, MESSAGE_BURST, now), wrong: 0, lastKey: null };
    // Attached first: a socket with no error listener crashes the process on a bad frame.
    ws.on("error", () => {});
    if (phoneWss.clients.size > MAX_PHONE_SOCKETS) {
      ws.terminate();
      return;
    }
    ws.on("message", (data, isBinary) => {
      const at = clock();
      ws.conn.lastHeard = at;
      if (isBinary || !take(ws.conn.limit, at)) {
        ws.close(1008, "too many messages");
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.close(1007, "bad message");
        return;
      }
      if (msg && typeof msg.t === "string") safely(() => handlePhone(ws, msg));
    });
    ws.on("close", () => {
      unwatch(ws);
      const personId = ws.conn.personId;
      if (personId !== null && personSocket.get(personId) === ws) {
        personSocket.delete(personId);
        phonesDirty = true;
        screenDirty = true;
      }
    });
  });

  function pingPhones() {
    const now = clock();
    for (const ws of phoneWss.clients) {
      const conn = ws.conn;
      if (!conn) continue;
      if (!conn.cid && now - conn.openedAt > HELLO_TIMEOUT_MS) {
        ws.terminate();
        continue;
      }
      if (now - conn.lastHeard > DEAD_AFTER_MS) {
        ws.terminate();
        continue;
      }
      send(ws, { t: "ping", s: now });
    }
  }

  // The host removed someone: their phone is told and let go.
  function dropPerson(personId) {
    const ws = personSocket.get(personId);
    personSocket.delete(personId);
    if (!ws) return;
    ws.conn.personId = null;
    send(ws, { t: "removed" });
    ws.close(4002, "removed");
  }

  // ---------- The big screen and the host panel ----------
  function screenMessage(ws, now) {
    const people = online();
    if (ws.role !== "host") return { t: "state", ...screenView(ix, now, people) };
    const ratingCounts = new Map();
    for (const r of ix.ratings) ratingCounts.set(r.team_id, (ratingCounts.get(r.team_id) ?? 0) + 1);
    const stickerCounts = new Map(store.all("SELECT team_id, COUNT(*) AS n FROM stickers WHERE removed_at IS NULL GROUP BY team_id").map((r) => [r.team_id, r.n]));
    return { t: "host", ...hostView(ix, now, people, { ratingCounts, stickerCounts }), join, ...hostInfo() };
  }

  function flushScreens(now) {
    screenDirty = false;
    lastScreenAt = now;
    for (const ws of screens) if (ws.role) send(ws, screenMessage(ws, now));
  }

  function toScreens(msg) {
    const data = JSON.stringify(msg);
    for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  function phaseChanged() {
    safely(() => backupDir && store.backup(backupDir, ix.phase));
    safely(() => onPhase?.(ix, store));
  }

  function handleScreen(ws, msg) {
    const now = clock();
    if (msg.t === "hello") {
      ws.role = msg.role === "host" ? "host" : "screen";
      send(ws, { t: "join", ...join });
      send(ws, screenMessage(ws, now));
      return;
    }
    if (msg.t === "sync") {
      if (Number.isFinite(msg.c)) send(ws, { t: "sync", c: msg.c, s: now });
      return;
    }
    // Only the host panel runs the event.
    if (ws.role !== "host") return;
    const run = HOST_COMMANDS[msg.t];
    if (!run) return;
    const result = run(ctx(), msg);
    if (!msg.dryRun) console.log(`${new Date(now).toLocaleTimeString()} HOST: ${msg.t}${result.error ? ` → ${result.error}` : ""}`);
    send(ws, { t: "result", op: typeof msg.op === "string" ? msg.op.slice(0, 40) : null, ...result });
    if (result.error || msg.dryRun) return;
    refresh();
    if (result.removed) dropPerson(result.removed);
    if (result.phaseChanged) phaseChanged();
    safely(() => onChange?.(ix, store));
    flushScreens(clock());
    flushPhones(clock());
  }

  screenWss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.role = null;
    screens.add(ws);
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === "string") safely(() => handleScreen(ws, msg));
    });
    ws.on("close", () => screens.delete(ws));
  });

  function tick() {
    const now = clock();
    if (phonesDirty || now - lastRefreshAt >= REFRESH_EVERY_MS) {
      lastRefreshAt = now;
      flushPhones(now);
    }
    if (screenDirty ? now - lastScreenAt >= SCREEN_EVERY_MS : now - lastScreenAt >= SCREEN_HEARTBEAT_MS) flushScreens(now);
  }

  return {
    store,
    get ix() {
      return ix;
    },
    online,

    // Where phones join. tunnel: "live" | "starting" | "down" | "missing" | "lan" | "off"
    setJoin(url, tunnel) {
      join = { url, qr: url ? pixelQr(url, "Scan to join") : null, tunnel };
      toScreens({ t: "join", ...join });
    },

    async listen({ phonePort = 3300, phoneHost = "127.0.0.1", screenPort = 3301 } = {}) {
      const ports = {
        phone: await listen(phoneHttp, phonePort, phoneHost),
        screen: await listen(screenHttp, screenPort, "127.0.0.1"),
      };
      timers = [setInterval(() => safely(pingPhones), pingEveryMs), setInterval(() => safely(tick), tickMs), setInterval(() => safely(flushPiles), PILE_EVERY_MS)];
      if (backupDir) timers.push(setInterval(() => safely(() => store.backup(backupDir, ix.phase)), BACKUP_EVERY_MS));
      return ports;
    },

    async close() {
      timers.forEach(clearInterval);
      // 1012: the server is restarting. Phones say BACK SOON and keep trying.
      for (const ws of phoneWss.clients) ws.close(1012, "restarting");
      for (const ws of screenWss.clients) ws.close(1012, "restarting");
      await new Promise((r) => setTimeout(r, 50));
      for (const ws of [...phoneWss.clients, ...screenWss.clients]) ws.terminate();
      phoneWss.close();
      screenWss.close();
      phoneHttp.closeAllConnections?.();
      screenHttp.closeAllConnections?.();
      await Promise.all([new Promise((r) => phoneHttp.close(r)), new Promise((r) => screenHttp.close(r))]);
    },
  };
}
