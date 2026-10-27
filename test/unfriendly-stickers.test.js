// Stickers end to end on the event's own rules: 8 teams, 24 team members and 60 people in the
// audience slap, peel and move stickers through a whole show, every limit is pushed, and the
// side-quest titles are checked against a tally kept here, independently of results.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../server/unfriendly/store.js";
import { index } from "../server/unfriendly/event.js";
import * as cmd from "../server/unfriendly/commands.js";
import * as show from "../server/unfriendly/show.js";
import { QUESTS, JOKES, JOKES_PER_TEAM, QUEST_EACH } from "../unfriendly/js/shared/rules.js";

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function event(seed) {
  let now = 1_800_000_000_000;
  const random = seeded(seed);
  const store = await openStore(":memory:", { now: () => now, judgePin: "6767" });
  const ctx = () => ({ store, ix: index(store.load()), now, random, scale: 1 });
  const me = (dev) => store.get("SELECT p.* FROM devices d JOIN people p ON p.id = d.person_id WHERE d.client_id = ? AND p.removed_at IS NULL", dev) ?? null;
  let ops = 0;
  const h = {
    store,
    random,
    ctx,
    advance: (ms) => (now += ms),
    phone: (dev, action, input = {}) => cmd[action](ctx(), me(dev), dev, input),
    act: (dev, action, input = {}) => show[action](ctx(), me(dev), dev, { op: `op-${(ops += 1)}`, ...input }),
    host: (action, input = {}) => (action in show ? show[action](ctx(), input) : cmd[action](ctx(), input)),
  };
  return h;
}

const NAMES = ["Aisha", "Ben", "Chloe", "Dev", "Ema", "Faris", "Gia", "Hari", "Ines", "Jude", "Kian", "Lena", "Maya", "Nico", "Omar", "Pia", "Quinn", "Rami", "Sana", "Theo", "Uma", "Vik", "Wren", "Yara"];

// Plays a show: teams, a deal, a build, every team presenting with five judges rating.
async function playShow(seed) {
  const h = await event(seed);
  assert.ok(h.host("settings", { maxTeams: 8, maxSize: 3 }).ok);
  const teams = [];
  for (let t = 0; t < 8; t += 1) {
    const made = h.phone(`maker-${t}`, "make", { name: `${NAMES[t * 3]} Maker`, team: `Team ${String.fromCharCode(65 + t)}` });
    assert.ok(made.ok, made.error);
    const code = h.ctx().ix.teamById.get(made.teamId).code;
    for (let m = 1; m < 3; m += 1) assert.ok(h.phone(`member-${t}-${m}`, "join", { name: `${NAMES[t * 3 + m]} Member`, code }).ok);
    teams.push({ id: made.teamId, devices: [`maker-${t}`, `member-${t}-1`, `member-${t}-2`] });
  }
  assert.ok(h.host("deal").ok);
  assert.ok(h.host("buildStart", { minutes: 55 }).ok);
  h.advance(56 * 60_000);
  assert.ok(h.host("presentStart", { minutes: 40 }).ok);
  const order = h.ctx().ix.demos.map((d) => d.team_id);

  // Five judges. The team presenting first gets 6 from everyone, the rest something in between.
  for (let j = 0; j < 5; j += 1) assert.ok(h.act(`judge-${j}`, "judgeNew", { pin: "6767", name: `Judge ${NAMES[j]}` }).ok);
  return { h, teams, order };
}

test("stickers: every limit holds, and the side-quest titles match an independent tally", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { h, teams, order } = await playShow(seed);
    const random = seeded(seed * 101);
    const fans = Array.from({ length: 60 }, (_, i) => `fan-${i}`);

    // Before anyone presents: no stickers, and the audience can sign up.
    for (const dev of fans) assert.ok(h.act(dev, "audience", { name: `Fan ${NAMES[(dev.length + Number(dev.slice(4))) % NAMES.length]} ${dev.slice(4)}`, ownTeam: null }).ok);
    assert.match(h.act("fan-0", "slap", { team: order[0], kind: "best-ui", x: 500, y: 500 }).error, /HASN'T PRESENTED/);

    // Each fan likes a few teams; the four red stickers go where they like most.
    const taste = new Map([...fans, ...teams.flatMap((t) => t.devices)].map((dev) => [dev, [...order].sort(() => random() - 0.5)]));
    const ledger = new Map(); // dev → Map(kind → { id, team })

    for (let slot = 0; slot < order.length; slot += 1) {
      assert.ok(h.host("demoStart").ok);
      for (let j = 0; j < 5; j += 1) {
        const value = slot === 0 ? 6 : 2 + Math.floor(random() * 4);
        assert.ok(h.act(`judge-${j}`, "rate", { team: order[slot], value }).ok);
      }
      h.advance(90_000);
      assert.ok(h.host("next").ok);
      h.advance(20_000);

      // Stickers on any team that has presented so far.
      const presented = order.slice(0, slot + 1);
      for (const dev of [...fans, ...teams.flatMap((t) => t.devices)]) {
        const own = teams.find((t) => t.devices.includes(dev))?.id ?? null;
        const mine = ledger.get(dev) ?? new Map();
        ledger.set(dev, mine);
        for (const q of QUESTS) {
          if (random() < 0.5) continue;
          const pick = taste.get(dev).find((id) => presented.includes(id) && id !== own);
          if (pick === undefined) continue;
          const had = mine.get(q.kind);
          if (had && had.team === pick) continue;
          if (had) {
            // Already used: a second one is refused; moving it is the way.
            assert.match(h.act(dev, "slap", { team: pick, kind: q.kind, x: 10, y: 10 }).error, /USED YOUR/);
            if (random() < 0.5) {
              assert.ok(h.act(dev, "move", { id: had.id, team: pick, x: 300, y: 300 }).ok);
              had.team = pick;
            } else {
              assert.ok(h.act(dev, "peel", { id: had.id }).ok);
              const again = h.act(dev, "slap", { team: pick, kind: q.kind, x: 400, y: 400 });
              assert.ok(again.ok, again.error);
              mine.set(q.kind, { id: again.sticker.id, team: pick });
            }
          } else {
            const r = h.act(dev, "slap", { team: pick, kind: q.kind, x: Math.floor(random() * 1000), y: Math.floor(random() * 1000) });
            assert.ok(r.ok, r.error);
            mine.set(q.kind, { id: r.sticker.id, team: pick });
          }
        }
        // Your own team is always refused.
        if (own !== null && presented.includes(own)) assert.match(h.act(dev, "slap", { team: own, kind: "why", x: 1, y: 1 }).error, /OWN TEAM/);
      }
      // Taste drifts a little as more teams present.
      for (const list of taste.values()) if (random() < 0.3) list.push(list.shift());
    }

    // Joke stickers: five per person per team, then refused; another team is fine.
    for (let i = 0; i < JOKES_PER_TEAM; i += 1) assert.ok(h.act("fan-0", "slap", { team: order[1], kind: JOKES[i % JOKES.length].kind, x: 50 * i, y: 50 }).ok);
    assert.match(h.act("fan-0", "slap", { team: order[1], kind: "why", x: 1, y: 1 }).error, /JOKE STICKERS PER TEAM/);
    assert.ok(h.act("fan-0", "slap", { team: order[2], kind: "why", x: 1, y: 1 }).ok);

    // Nobody holds more than one of each red sticker, and four at most in all.
    const held = h.store.all("SELECT person_id, kind, COUNT(*) AS n FROM stickers WHERE quest = 1 AND removed_at IS NULL GROUP BY person_id, kind");
    assert.ok(held.every((r) => r.n <= QUEST_EACH));
    const perPerson = h.store.all("SELECT person_id, COUNT(*) AS n FROM stickers WHERE quest = 1 AND removed_at IS NULL GROUP BY person_id");
    assert.ok(perPerson.every((r) => r.n <= QUESTS.length * QUEST_EACH));
    assert.equal(h.store.get("SELECT COUNT(*) AS n FROM stickers s JOIN people p ON p.id = s.person_id WHERE s.removed_at IS NULL AND p.role = 'participant' AND s.team_id = p.team_id").n, 0, "nobody's sticker is on their own team");

    // The tally kept here: what's stuck where, after every peel and move.
    const count = new Map();
    for (const mine of ledger.values()) for (const [kind, s] of mine) count.set(`${s.team}|${kind}`, (count.get(`${s.team}|${kind}`) ?? 0) + 1);
    const fromDb = h.store.all("SELECT team_id, kind, COUNT(*) AS n FROM stickers WHERE quest = 1 AND removed_at IS NULL GROUP BY team_id, kind");
    assert.equal(fromDb.length, count.size);
    for (const r of fromDb) assert.equal(r.n, count.get(`${r.team_id}|${r.kind}`), `${r.team_id} ${r.kind}`);

    assert.ok(h.host("resultsStart").ok);
    assert.match(h.act("fan-1", "slap", { team: order[3], kind: "why", x: 1, y: 1 }).error, /CLOSED/);
    const results = h.ctx().ix.meta.results_json;
    const won = Object.fromEntries(results.awards.map((a) => [a.key, a.team?.id ?? null]));

    // The main award: the team everyone gave 6.
    assert.equal(won.main, order[0]);

    // Side quests, worked out again here: biggest share of a quest first, one title per team,
    // the main award's team out.
    const totals = new Map();
    for (const [key, n] of count) totals.set(key.split("|")[1], (totals.get(key.split("|")[1]) ?? 0) + n);
    const rows = [...count].map(([key, n]) => ({ team: Number(key.split("|")[0]), kind: key.split("|")[1], n, share: n / totals.get(key.split("|")[1]) }));
    // Ties go to the judges' score, then the quest listed first.
    const teamName = (id) => h.ctx().ix.teamById.get(id).name;
    const judged = (id) => results.numbers.judges[teamName(id)]?.score ?? -Infinity;
    const questAt = (kind) => QUESTS.findIndex((q) => q.kind === kind);
    rows.sort((a, b) => b.share - a.share || b.n - a.n || judged(b.team) - judged(a.team) || a.team - b.team || questAt(a.kind) - questAt(b.kind));
    const taken = new Set([won.main]);
    const expected = {};
    for (const r of rows) {
      if (r.kind in expected || taken.has(r.team)) continue;
      expected[r.kind] = r.team;
      taken.add(r.team);
    }
    for (const q of QUESTS) assert.equal(won[q.kind], expected[q.kind] ?? null, `seed ${seed} ${q.kind}`);
    const titled = Object.values(won).filter((id) => id !== null);
    assert.equal(new Set(titled).size, titled.length, "one title per team");
    for (const a of results.awards.filter((a) => a.key !== "main" && a.team)) {
      assert.equal(a.detail.stickers, count.get(`${a.team.id}|${a.key}`), "the sticker count shown is the real one");
      assert.ok(a.team.members.length === 3, "the winners' members are there for the certificates");
    }

    // The reveal is frozen: a later sticker change can't move a title.
    h.store.run("UPDATE stickers SET removed_at = 1 WHERE quest = 1");
    assert.deepEqual(h.ctx().ix.meta.results_json.awards.map((a) => a.team?.id ?? null), results.awards.map((a) => a.team?.id ?? null));
    h.store.close();
  }
});

test("stickers: a crowd that all loves one team still gives out every title", async () => {
  const { h, teams, order } = await playShow(9);
  for (let slot = 0; slot < order.length; slot += 1) {
    assert.ok(h.host("demoStart").ok);
    for (let j = 0; j < 5; j += 1) assert.ok(h.act(`judge-${j}`, "rate", { team: order[slot], value: slot === 0 ? 6 : 3 }).ok);
    assert.ok(h.host("next").ok);
  }
  // 40 fans put all four red stickers on the same team (order[1]); a few go elsewhere.
  for (let i = 0; i < 40; i += 1) {
    const joined = h.act(`f-${i}`, "audience", { name: `${NAMES[i % NAMES.length]} ${["Lee", "Kay"][Math.floor(i / NAMES.length)]}`, ownTeam: null });
    assert.ok(joined.ok, joined.error);
    for (const [k, q] of QUESTS.entries()) {
      const team = i < 36 ? order[1] : order[2 + k];
      assert.ok(h.act(`f-${i}`, "slap", { team, kind: q.kind, x: 500, y: 500 }).ok);
    }
  }
  assert.ok(h.host("resultsStart").ok);
  const won = Object.fromEntries(h.ctx().ix.meta.results_json.awards.map((a) => [a.key, a.team?.id ?? null]));
  assert.equal(won.main, order[0]);
  const quests = QUESTS.map((q) => won[q.kind]);
  assert.equal(quests.filter((id) => id === order[1]).length, 1, "the crowd's favourite takes one title, not four");
  assert.ok(quests.every((id) => id !== null), "every side quest still has a winner");
  assert.equal(new Set(quests).size, 4);
  assert.ok(teams.length === 8);
  h.store.close();
});
