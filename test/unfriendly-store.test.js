// USER UNFRIENDLY: the commands against a real SQLite file. Teams are made, joined and grouped,
// the cards dealt and swapped, and the file is closed and opened again in the middle to check a
// restarted server sees exactly the same event.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, takeLock, archiveDatabase } from "../server/unfriendly/store.js";
import { index, participantView, screenView, hostView } from "../server/unfriendly/event.js";
import * as cmd from "../server/unfriendly/commands.js";

function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uu-test-"));
}

// A tiny harness: a clock we move by hand, and a ctx rebuilt from the database for every command.
async function event(file = ":memory:") {
  let now = 1_800_000_000_000;
  const random = seeded(11);
  const store = await openStore(file, { now: () => now });
  const h = {
    store,
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    ix: () => index(store.load()),
    ctx: () => ({ store, ix: index(store.load()), now, random, scale: 1 }),
    me: (deviceId) => {
      const row = store.get("SELECT p.* FROM devices d JOIN people p ON p.id = d.person_id WHERE d.client_id = ? AND p.removed_at IS NULL", deviceId);
      return row ?? null;
    },
    phone: (deviceId, action, input = {}) => cmd[action](h.ctx(), h.me(deviceId), deviceId, input),
  };
  return h;
}

test("make, join, pool, group, deal, swap: the whole start of the event", async () => {
  const h = await event();
  h.store.tx(() => h.store.setMeta("max_teams", 3));

  const made = h.phone("dev-aaaaaaaa", "make", { name: "Aisha Khan", team: "The Pop-Ups" });
  assert.ok(made.ok, made.error);
  const code = h.ix().teams[0].code;
  assert.match(code, /^[A-Z]{4}$/);

  assert.ok(h.phone("dev-bbbbbbbb", "join", { name: "Ben", code: code.toLowerCase() }).ok);
  assert.equal(h.phone("dev-cccccccc", "join", { name: "aisha khan", code }).error, "SOMEONE HERE ALREADY HAS THAT NAME. ADD AN INITIAL.");
  assert.equal(h.phone("dev-cccccccc", "join", { name: "Cy", code: "ZZZZ" }).wrongCode, true);
  assert.equal(h.phone("dev-dddddddd", "make", { name: "Dee", team: "the pop-ups" }).error, "THAT TEAM NAME IS TAKEN.");

  // Asking twice (a message resent after a reconnect) changes nothing.
  assert.equal(h.phone("dev-aaaaaaaa", "make", { name: "Aisha Khan", team: "Another" }).already, true);

  for (const [dev, name] of [["dev-p1aaaaaa", "Pia"], ["dev-p2aaaaaa", "Raj"], ["dev-p3aaaaaa", "Sam"], ["dev-p4aaaaaa", "Tia"]]) {
    assert.ok(h.phone(dev, "pool", { name }).ok);
  }
  assert.match(cmd.deal(h.ctx()).error, /4 PEOPLE ARE STILL WAITING/);

  const preview = cmd.group(h.ctx(), { dryRun: true });
  assert.ok(preview.ok);
  assert.equal(h.ix().pool.length, 4, "a dry run changes nothing");
  const done = cmd.group(h.ctx(), {});
  assert.deepEqual(done.lines, preview.lines, "what the host confirmed is exactly what happens");
  let ix = h.ix();
  assert.equal(ix.pool.length, 0);
  assert.equal(ix.teams.length, 2, "one new team of 3, the fourth joins the smallest");
  assert.deepEqual(ix.teams.map((t) => ix.members.get(t.id).length).sort(), [3, 3]);

  // The deal: every team two different cards and its own swap window.
  assert.ok(cmd.deal(h.ctx()).ok);
  ix = h.ix();
  assert.equal(ix.phase, "deal");
  for (const t of ix.teams) {
    assert.equal(t.cards.length, 2);
    assert.notEqual(t.cards[0], t.cards[1]);
    assert.equal(t.swap_until, h.now + 5 * 60_000);
  }
  assert.equal(new Set(ix.teams.flatMap((t) => t.cards)).size, 4, "no repeats while the deck lasts");

  // A late team made after the deal is dealt at once.
  h.advance(60_000);
  assert.ok(h.phone("dev-late0000", "make", { name: "Late Lee", team: "Latecomers" }).ok);
  ix = h.ix();
  const late = ix.teams.find((t) => t.name === "Latecomers");
  assert.equal(late.cards.length, 2);
  assert.equal(late.swap_until, h.now + 5 * 60_000, "its own five minutes");
  assert.equal(h.phone("dev-late2222", "make", { name: "Too Late", team: "Fourth" }).error, "ALL 3 TEAMS ARE MADE. JOIN ONE, OR TAP FIND ME A TEAM.");

  // One swap, once.
  const before = ix.teams[0].cards;
  const swapped = h.phone("dev-aaaaaaaa", "swap", { slot: 1 });
  assert.ok(swapped.ok, swapped.error);
  const after = h.ix().teams[0].cards;
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(h.phone("dev-bbbbbbbb", "swap", { slot: 0 }).already, true, "the team's one swap is used");
  assert.match(cmd.undoDeal(h.ctx()).error, /ALREADY SWAPPED/);

  // The swap window closes by time alone.
  h.advance(5 * 60_000);
  const second = h.ix().teams[1];
  const member = h.ix().members.get(second.id)[0];
  const dev = h.store.get("SELECT client_id FROM devices WHERE person_id = ?", member.id).client_id;
  assert.equal(h.phone(dev, "swap", { slot: 0 }).error, "THE SWAP WINDOW HAS CLOSED.");
  assert.ok(cmd.reopenSwap(h.ctx(), { teamId: second.id, ms: 120_000 }).ok);
  assert.ok(h.phone(dev, "swap", { slot: 0 }).ok);
});

test("views: the big screen never shows a team code, the host panel does", async () => {
  const h = await event();
  h.phone("dev-aaaaaaaa", "make", { name: "Aisha", team: "Alpha" });
  const ix = h.ix();
  const code = ix.teams[0].code;
  assert.ok(!JSON.stringify(screenView(ix, h.now)).includes(code));
  assert.ok(JSON.stringify(hostView(ix, h.now)).includes(code));
  const me = participantView(ix, h.me("dev-aaaaaaaa"), h.now);
  assert.equal(me.team.code, code);
  assert.equal(me.team.members[0].you, true);
});

test("getting back in on a new address: by team code and name, or by name alone", async () => {
  const h = await event();
  h.phone("dev-aaaaaaaa", "make", { name: "Zoë O'Brien", team: "Alpha" });
  h.phone("dev-bbbbbbbb", "pool", { name: "Ben Lee" });
  const ix = h.ix();
  const team = ix.teams[0];
  const zoe = ix.people.find((p) => p.name === "Zoë O'Brien");

  const found = cmd.lookup(h.ctx(), { code: team.code.toLowerCase() });
  assert.deepEqual(found.team.members.map((m) => m.name), ["Zoë O'Brien"]);
  assert.equal(cmd.claim(h.ctx(), "new-device-1", { personId: zoe.id, code: "AAAA" }).wrongCode, true);
  assert.ok(cmd.claim(h.ctx(), "new-device-1", { personId: zoe.id, code: team.code }).ok);
  assert.equal(h.me("new-device-1").id, zoe.id);

  const byName = cmd.findByName(h.ctx(), { name: "ben lee" });
  assert.deepEqual(byName.found.map((f) => f.team), [null], "still waiting for a team");
  assert.ok(cmd.claim(h.ctx(), "new-device-2", { personId: byName.found[0].id, name: "BEN LEE" }).ok);
  assert.equal(cmd.claim(h.ctx(), "new-device-3", { personId: byName.found[0].id, name: "Benjamin" }).wrongCode, true);
});

test("a restarted server sees exactly the same event (close the file, open it again)", async () => {
  const dir = tempDir();
  const file = path.join(dir, "event.db");
  const h = await event(file);
  h.phone("dev-aaaaaaaa", "make", { name: "Aisha", team: "Alpha" });
  h.phone("dev-bbbbbbbb", "make", { name: "Ben", team: "Beta" });
  cmd.deal(h.ctx());
  h.phone("dev-aaaaaaaa", "swap", { slot: 0 });
  cmd.buildStart(h.ctx(), { minutes: 55 });
  const before = h.store.load();
  h.store.close();

  const again = await openStore(file, { now: () => h.now });
  const after = again.load();
  assert.deepEqual(after, before);
  assert.equal(index(after).phase, "build");
  assert.equal(after.meta.build_end_at, h.now + 55 * 60_000);
  again.close();
});

test("only one server per database, and starting fresh keeps the old event in archive/", async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, "unfriendly.lock");
  const release = takeLock(lockPath);
  // Pretend another live process holds it: our own parent process is alive.
  fs.writeFileSync(lockPath, String(process.ppid));
  assert.throws(() => takeLock(lockPath), /already running/i);
  // A lock left by a process that died is taken over.
  fs.writeFileSync(lockPath, "999999");
  const again = takeLock(lockPath);
  again();
  release();

  const file = path.join(dir, "event.db");
  const h = await event(file);
  h.phone("dev-aaaaaaaa", "make", { name: "Aisha", team: "Alpha" });
  h.store.close();
  const archived = await archiveDatabase(file, path.join(dir, "archive"));
  assert.ok(fs.existsSync(archived));
  assert.ok(!fs.existsSync(file));
  const fresh = await openStore(file);
  assert.equal(fresh.load().teams.length, 0);
  fresh.close();
  const old = await openStore(archived);
  assert.equal(old.load().teams.length, 1);
  old.close();
});

test("the host: settings, removing people and teams, undoing a deal in time", async () => {
  const h = await event();
  assert.match(cmd.settings(h.ctx(), { maxTeams: 0 }).error, /TEAMS/);
  assert.ok(cmd.settings(h.ctx(), { maxTeams: 2, maxSize: 3 }).ok);
  h.phone("dev-aaaaaaaa", "make", { name: "Aisha", team: "Alpha" });
  h.phone("dev-bbbbbbbb", "make", { name: "Ben", team: "Beta" });
  assert.match(cmd.settings(h.ctx(), { maxTeams: 1 }).error, /ALREADY 2 TEAMS/);
  const code = h.ix().teams[0].code;
  h.phone("dev-cccccccc", "join", { name: "Cy", code });
  h.phone("dev-dddddddd", "join", { name: "Di", code });
  assert.match(h.phone("dev-eeeeeeee", "join", { name: "Ed", code }).error, /IS FULL \(3\)/);

  // Removing a team sends its people back to waiting.
  const beta = h.ix().teams[1];
  assert.ok(cmd.editTeam(h.ctx(), { id: beta.id, remove: true }).ok);
  assert.equal(h.ix().pool.length, 1);
  assert.ok(cmd.group(h.ctx(), {}).ok);

  assert.ok(cmd.deal(h.ctx()).ok);
  h.advance(30_000);
  assert.ok(cmd.undoDeal(h.ctx()).ok);
  assert.equal(h.ix().phase, "join");
  assert.ok(h.ix().teams.every((t) => t.cards.length === 0));
  assert.ok(cmd.deal(h.ctx()).ok);
  h.advance(3 * 60_000);
  assert.match(cmd.undoDeal(h.ctx()).error, /TOO LATE/);

  const ben = h.ix().people.find((p) => p.name === "Ben");
  assert.ok(cmd.editPerson(h.ctx(), { id: ben.id, remove: true }).ok);
  assert.equal(h.me("dev-bbbbbbbb"), null, "a removed person's phone is no longer them");
});
