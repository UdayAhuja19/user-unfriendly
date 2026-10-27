// USER UNFRIENDLY's second half with real sockets: links, presenting, judges, stickers, results
// and the certificate lists. Plus the scoring on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { createUnfriendlyServer } from "../server/unfriendly/server.js";
import { openStore } from "../server/unfriendly/store.js";
import { computeResults, judgeScores, csv } from "../server/unfriendly/results.js";
import { siteUrl } from "../unfriendly/js/shared/rules.js";

function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.messages = [];
    ws.on("message", (data) => ws.messages.push(JSON.parse(data)));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
async function until(ws, check, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const msg = [...ws.messages].reverse().find(check);
    if (msg) return msg;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
let seq = 0;
async function act(ws, msg) {
  const op = `op-${String((seq += 1)).padStart(6, "0")}`;
  ws.send(JSON.stringify({ ...msg, op }));
  return until(ws, (m) => m.op === op);
}
const lastView = (ws, check = () => true) => until(ws, (m) => m.t === "view" && check(m.view));

test("links, presenting, judges, stickers and results", { timeout: 30_000 }, async () => {
  const store = await openStore(":memory:", { judgePin: "2710" });
  const server = createUnfriendlyServer({ store, tickMs: 20 });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const url = `ws://127.0.0.1:${ports.phone}/ws`;
  const host = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  host.send(JSON.stringify({ t: "hello", role: "host" }));
  const run = async (t, payload = {}) => {
    const op = `host-${(seq += 1)}`;
    host.send(JSON.stringify({ t, op, ...payload }));
    const r = await until(host, (m) => m.t === "result" && m.op === op);
    return r;
  };
  const phone = async (cid) => {
    const ws = await open(url);
    ws.send(JSON.stringify({ t: "hello", cid }));
    await until(ws, (m) => m.t === "who" || m.t === "view");
    return ws;
  };
  try {
    // Four teams of two.
    const members = [];
    for (let i = 0; i < 4; i += 1) {
      const a = await phone(`maker-${i}-aaaa`);
      assert.equal((await act(a, { t: "make", name: `Maker ${i}`, team: `Team ${i}` })).t, "ok");
      const code = (await lastView(a, (v) => v.team)).view.team.code;
      const b = await phone(`joiner-${i}-aaaa`);
      assert.equal((await act(b, { t: "join", name: `Joiner ${i}`, code })).t, "ok");
      members.push({ a, b, code });
    }
    assert.ok((await run("deal")).ok);
    assert.ok((await run("buildStart", { minutes: 55 })).ok);

    // ---- Links ----
    assert.match((await act(members[0].a, { t: "link", url: "https://a.example.com" })).error, /AREN'T OPEN/);
    assert.ok((await run("linksOpen")).ok);
    assert.equal((await act(members[0].a, { t: "link", url: "alpha.lovable.app" })).t, "ok", "a member doesn't need the code");
    const stranger = await phone("new-address-01");
    assert.match((await act(stranger, { t: "link", code: members[1].code, url: "http://localhost:5173" })).error, /ONLY WORKS ON YOUR LAPTOP/);
    assert.equal((await act(stranger, { t: "link", code: members[1].code, url: "https://claude.ai/public/artifacts/abc" })).t, "ok");
    const teams = (await until(host, (m) => m.t === "host" && m.teams.filter((t) => t.link).length === 2)).teams;
    assert.equal(teams[0].link.host, "alpha.lovable.app");
    assert.ok((await run("hostLink", { teamId: teams[2].id, ownLaptop: true })).ok);

    // ---- Presenting ----
    assert.ok((await run("presentStart", { minutes: 40 })).ok);
    const order = (await until(host, (m) => m.t === "host" && m.phase === "present" && m.order.length === 4)).order;

    // ---- Judges ----
    const judge = await phone("judge-phone-1");
    assert.equal((await act(judge, { t: "judges", pin: "0000" })).t, "no");
    assert.deepEqual((await act(judge, { t: "judges", pin: "2710" })).judges, []);
    assert.equal((await act(judge, { t: "judgeNew", pin: "2710", name: "Rayyan" })).t, "ok");
    const judge2 = await phone("judge-phone-2");
    assert.equal((await act(judge2, { t: "judgeNew", pin: "2710", name: "Ronak" })).t, "ok");
    assert.match((await act(judge, { t: "rate", team: order[0].teamId, value: 6 })).error, /CLOSED/, "not before the demo starts");
    assert.ok((await run("demoStart")).ok);
    // The site on the big screen: only a team with a link, and only while it's on stage.
    const firstLink = teams.find((t) => t.id === order[0].teamId).link;
    if (firstLink?.url) {
      assert.ok((await run("siteShow", { on: true })).ok);
      const shown = await until(host, (m) => m.t === "host" && m.show?.current?.site);
      assert.equal(shown.show.current.site, firstLink.url);
    } else assert.match((await run("siteShow", { on: true })).error, /NO LINK/);
    assert.equal((await act(judge, { t: "rate", team: order[0].teamId, value: 5 })).t, "ok");
    assert.equal((await act(judge, { t: "rate", team: order[0].teamId, value: 6 })).t, "ok", "can change it during the demo");
    assert.match((await act(judge, { t: "rate", team: order[1].teamId, value: 6 })).error, /CLOSED/);
    assert.ok((await run("next")).ok);
    assert.equal((await act(judge2, { t: "rate", team: order[0].teamId, value: 2 })).t, "ok", "a first rating just after NEXT still counts");
    assert.match((await act(judge, { t: "rate", team: order[0].teamId, value: 1 })).error, /CLOSED/, "but not a change");
    assert.equal((await until(host, (m) => m.t === "host" && m.show?.current?.slot === 1)).show.current.site, null, "the next team starts without it");
    const jv = (await lastView(judge, (v) => v.current?.slot === 1)).view;
    assert.equal(jv.current.name, (await until(host, (m) => m.t === "host")).order[1].name);

    // ---- Stickers ----
    const fan = await phone("sticker-fan-1");
    assert.equal((await act(fan, { t: "audience", name: "Fan One", ownTeam: order[0].teamId })).t, "ok");
    assert.match((await act(fan, { t: "slap", team: order[0].teamId, kind: "best-ui", x: 500, y: 500 })).error, /NOT YOUR OWN TEAM/);
    assert.match((await act(fan, { t: "slap", team: order[2].teamId, kind: "best-ui", x: 500, y: 500 })).error, /HASN'T PRESENTED/);
    assert.ok((await run("demoStart")).ok); // team 2 of 4 is on
    const watcher = await phone("sticker-watch-2");
    await act(watcher, { t: "audience", name: "Watcher", ownTeam: null });
    watcher.send(JSON.stringify({ t: "watch", team: order[1].teamId }));
    await until(watcher, (m) => m.t === "pile" && m.team === order[1].teamId);
    assert.equal((await act(fan, { t: "slap", team: order[1].teamId, kind: "best-ui", x: 100, y: 200 })).t, "ok");
    assert.match((await act(fan, { t: "slap", team: order[1].teamId, kind: "best-ui", x: 1, y: 1 })).error, /USED YOUR BEST UI STICKER/, "one of each side quest per person");
    const pile = await until(watcher, (m) => m.t === "pile+" && m.add.length >= 1);
    assert.equal(pile.add[0][1], "best-ui", "the watching phone sees stickers land");
    assert.equal((await lastView(fan, (v) => v.stickers?.left["best-ui"] === 0)).view.stickers.left.funniest, 1);
    // Peel one and it can go again.
    const mine = (await until(fan, (m) => m.t === "ok" && m.id)).id;
    assert.equal((await act(fan, { t: "peel", id: mine })).t, "ok");
    assert.equal((await act(fan, { t: "slap", team: order[1].teamId, kind: "best-ui", x: 9, y: 9 })).t, "ok");
    assert.match((await act(watcher, { t: "peel", id: mine + 1 })).error, /ISN'T YOUR STICKER/);
    for (const k of ["funniest", "creative"]) await act(fan, { t: "slap", team: order[0].teamId === order[1].teamId ? order[2].teamId : order[1].teamId, kind: k, x: 5, y: 5 });

    // ---- Results ----
    assert.ok((await run("next")).ok);
    assert.ok((await run("resultsStart")).ok);
    assert.match((await act(fan, { t: "slap", team: order[1].teamId, kind: "why", x: 1, y: 1 })).error, /CLOSED/);
    assert.ok((await run("reveal")).ok);
    const all = (await until(host, (m) => m.t === "host" && m.phase === "results" && m.resultsAll)).resultsAll;
    const main = all.awards.find((a) => a.key === "main");
    assert.equal(main.team.id, order[0].teamId, "rated 6 and 2 by two judges: the only team with ratings");
    const bestUi = all.awards.find((a) => a.key === "best-ui");
    assert.equal(bestUi.team.id, order[1].teamId);
    const res = await fetch(`http://127.0.0.1:${ports.screen}/export/winners.csv`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a BOM, so Excel shows accents");
    const text = bytes.toString("utf8");
    assert.ok(text.includes("Award,Team,Name on certificate"));
    assert.ok(text.includes("Best UI"));

    // One click: every file in one zip that opens with a double-click.
    const zipped = Buffer.from(await (await fetch(`http://127.0.0.1:${ports.screen}/export/certificates.zip`)).arrayBuffer());
    assert.equal(zipped.readUInt32LE(0), 0x04034b50, "a zip file");
    const zipPath = path.join(os.tmpdir(), `uu-${process.pid}.zip`);
    fs.writeFileSync(zipPath, zipped);
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    for (const name of ["winners.csv", "participants.csv", "judges.csv", "everything.json"]) assert.ok(listing.includes(name), name);
    assert.ok(execFileSync("unzip", ["-p", zipPath, "winners.csv"], { encoding: "utf8" }).includes("Award,Team,Name on certificate"));
    fs.unlinkSync(zipPath);

    // After the last award, one more step is the end screen; it stays there.
    for (let i = 0; i < 6; i += 1) await run("reveal");
    const end = await until(host, (m) => m.t === "host" && m.results?.ended === true);
    assert.equal(end.results.awards.length, end.results.total);
    assert.equal((await run("reveal")).step, end.results.total + 1, "no further than the end screen");
    for (const ws of [...members.flatMap((m) => [m.a, m.b]), stranger, judge, judge2, fan, watcher]) ws.close();
    host.close();
  } finally {
    await server.close();
    store.close();
  }
});

test("judging: harsh and generous judges count the same, and the extremes are trimmed", () => {
  // Judge 1 gives everyone 1 or 2; judge 2 gives everyone 5 or 6. Both prefer team A.
  const ratings = [
    { judge_id: 1, team_id: "A", value: 2 }, { judge_id: 1, team_id: "B", value: 1 },
    { judge_id: 2, team_id: "A", value: 6 }, { judge_id: 2, team_id: "B", value: 5 },
  ];
  const s = judgeScores(ratings, 1);
  assert.ok(s.get("A").score > s.get("B").score);
  // A judge who rates everything the same moves nothing.
  const flat = judgeScores([...ratings, { judge_id: 3, team_id: "A", value: 4 }, { judge_id: 3, team_id: "B", value: 4 }], 1);
  assert.ok(flat.get("A").score > flat.get("B").score);
});

test("titles: one per team, main award first, side quests by share", () => {
  const team = (id) => ({ id, name: `T${id}`, cards: [], members: [{ name: `P${id}` }] });
  const r = computeResults({
    teams: [1, 2, 3].map(team),
    presented: new Set([1, 2, 3]),
    ratings: [1, 2, 3, 4, 5].flatMap((j) => [{ judge_id: j, team_id: 1, value: 6 }, { judge_id: j, team_id: 2, value: 3 }]),
    stickers: [
      ...Array(5).fill({ team_id: 1, kind: "best-ui" }), // team 1 wins the main award, so it can't take Best UI
      ...Array(3).fill({ team_id: 2, kind: "best-ui" }),
      ...Array(4).fill({ team_id: 2, kind: "funniest" }),
      { team_id: 3, kind: "funniest" },
    ],
    judges: 5,
  });
  const by = Object.fromEntries(r.awards.map((a) => [a.key, a.team?.id ?? null]));
  assert.equal(by.main, 1);
  assert.equal(by.funniest, 2, "team 2's biggest share");
  assert.equal(by["best-ui"], null, "team 1 has it, but already won; team 2 already has a title");
  assert.equal(by.creative, null);
  assert.equal(r.awards.at(-1).key, "main", "revealed last");
});

test("links and CSV are safe", () => {
  assert.equal(siteUrl("site.vercel.app").url, "https://site.vercel.app/");
  for (const bad of ["javascript:alert(1)", "http://192.168.1.4:3000", "https://user:pw@x.com", "file:///etc/passwd", "http://intranet"]) assert.ok(siteUrl(bad).error, bad);
  assert.equal(csv([["=SUM(A1)", "Zoë, \"Z\""]]), '﻿\'=SUM(A1),"Zoë, ""Z"""\r\n');
});

test("the host adds a team late: a code, a feature, the last slot, and joins by code", { timeout: 20_000 }, async () => {
  const store = await openStore(":memory:", { judgePin: "2710" });
  const server = createUnfriendlyServer({ store, tickMs: 20 });
  const ports = await server.listen({ phonePort: 0, screenPort: 0 });
  const url = `ws://127.0.0.1:${ports.phone}/ws`;
  const host = await open(`ws://127.0.0.1:${ports.screen}/ws`, { origin: `http://127.0.0.1:${ports.screen}` });
  host.send(JSON.stringify({ t: "hello", role: "host" }));
  const run = async (t, payload = {}) => {
    const op = `host-${(seq += 1)}`;
    host.send(JSON.stringify({ t, op, ...payload }));
    return until(host, (m) => m.t === "result" && m.op === op);
  };
  const phone = async (cid) => {
    const ws = await open(url);
    ws.send(JSON.stringify({ t: "hello", cid }));
    await until(ws, (m) => m.t === "who" || m.t === "view");
    return ws;
  };
  try {
    const a = await phone("early-maker-01");
    assert.equal((await act(a, { t: "make", name: "Early Bird", team: "On Time" })).t, "ok");
    const onTime = store.all("SELECT code FROM teams WHERE name = 'On Time'")[0].code;
    assert.equal((await run("deal")).ok, true);
    assert.equal((await run("buildStart", { minutes: 55 })).ok, true);

    // During the build: dealt one feature straight away.
    const built = await run("addTeam", { name: "Walk Ins", members: ["Ana Late", "Bo Late"] });
    assert.equal(built.ok, true);
    assert.match(built.code, /^[A-Z]{4}$/);
    const walkIns = store.all("SELECT id FROM teams WHERE name = 'Walk Ins'")[0].id;
    assert.equal(store.all("SELECT COUNT(*) AS n FROM team_cards WHERE team_id = ?", walkIns)[0].n, 1);
    assert.equal((await run("addTeam", { name: "Walk Ins", members: [] })).ok, undefined, "names stay unique");
    assert.match((await run("addTeam", { name: "Twins", members: ["Sam Same", "sam same"] })).error, /SAME NAME/);

    assert.match((await run("presentStart", { minutes: 40, demoSeconds: 5 })).error, /20 SECONDS TO 10 MINUTES/);
    assert.equal((await run("presentStart", { minutes: 40, demoSeconds: 210 })).ok, true);
    assert.equal(store.getMeta("demo_ms"), 210_000, "the host's own demo length, past the 2-minute auto cap");
    assert.equal((await run("demoLength", { seconds: 300 })).ok, true);
    assert.equal(store.getMeta("demo_ms"), 300_000);
    assert.equal(store.all("SELECT team_id FROM demos ORDER BY slot").at(-1).team_id, walkIns, "a host-added team presents last");
    // During presenting: last in the running order.
    const late = await run("addTeam", { name: "Very Late", members: [] });
    assert.equal(late.ok, true);
    const order = store.all("SELECT team_id FROM demos ORDER BY slot");
    assert.equal(order.length, 3);
    assert.equal(order.at(-1).team_id, store.all("SELECT id FROM teams WHERE name = 'Very Late'")[0].id);

    // Phones: an old team stays locked, the late team takes a new member by code.
    const newcomer = await phone("late-joiner-01");
    assert.match((await act(newcomer, { t: "join", name: "Cy New", code: onTime })).error, /LOCKED/);
    const found = await act(newcomer, { t: "lookup", code: late.code });
    assert.equal(found.team.canJoin, true);
    assert.equal((await act(newcomer, { t: "join", name: "Cy New", code: late.code })).t, "ok");
    const { view } = await lastView(newcomer, (v) => v.team);
    assert.equal(view.team.name, "Very Late");
    assert.equal(view.team.cards.length, 1);
    // A member the host typed in gets back in with the code and their name.
    const ana = await phone("ana-phone-01");
    const list = await act(ana, { t: "lookup", code: built.code });
    const me = list.team.members.find((m) => m.name === "Ana Late");
    assert.equal((await act(ana, { t: "claim", personId: me.id, code: built.code })).t, "ok");

    // After the results, no more teams.
    for (let i = 0; i < 3; i += 1) await run("next");
    assert.equal((await run("resultsStart")).ok, true);
    assert.match((await run("addTeam", { name: "Too Late", members: [] })).error, /RESULTS/);
  } finally {
    await server.close();
  }
});
