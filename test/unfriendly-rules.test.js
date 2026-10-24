// USER UNFRIENDLY: the shared name and code rules, the feature deck and how the people waiting
// for a team are grouped. All pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameKey, personName, teamCode, teamName } from "../unfriendly/js/shared/rules.js";
import { FEATURES, dealPair, drawCard, groupPool, newCode, newPile, swapCard } from "../server/unfriendly/deck.js";

// A seeded random, so every run deals the same cards.
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

test("names are kept as typed for certificates: accents, apostrophes and hyphens", () => {
  assert.deepEqual(personName("  Zoë   O'Brien "), { name: "Zoë O'Brien", key: "zoe o brien" });
  assert.equal(personName("Mohammed Abdulrahman Al-Hashimi").name, "Mohammed Abdulrahman Al-Hashimi");
  assert.equal(personName("Zeb Khan").name, "Zeb Khan", "a real name the arcade's whole-word list would refuse");
  assert.ok(personName("A").error);
  assert.ok(personName("x".repeat(41)).error);
  assert.ok(personName("1234").error, "needs a letter");
  assert.ok(personName("<script>").error);
  assert.ok(personName("Big Shit").error);
  assert.equal(nameKey("ÁÍSHA  khan"), nameKey("aisha-khan"));
});

test("team names and codes", () => {
  assert.equal(teamName("The Pop-Ups!").name, "The Pop-Ups!");
  assert.ok(teamName("a").error);
  assert.ok(teamName("Team Sex").error, "team names get the full blocklist");
  assert.equal(teamCode(" kxa-m "), "KXAM", "spaces, dashes and case don't matter");
  assert.equal(teamCode("kxam"), "KXAM");
  assert.equal(teamCode("KXOM"), null, "O isn't a code letter");
  assert.equal(teamCode("KXA"), null);
  const taken = new Set();
  const random = seeded(1);
  for (let i = 0; i < 300; i += 1) taken.add(newCode(taken, random));
  assert.equal(taken.size, 300);
});

test("the deck: 24 different features, no repeats until it runs out, never twice to one team", () => {
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, 24);
  const random = seeded(3);
  const pile = newPile(random);
  const dealt = [];
  for (let i = 0; i < 12; i += 1) dealt.push(dealPair(pile, random).cards);
  assert.equal(new Set(dealt.flat()).size, 24, "12 teams use the whole deck once");
  // Keep dealing past the end of the deck: still never the same card twice to one team.
  for (let i = 0; i < 30; i += 1) {
    const { cards } = dealPair(pile, random);
    assert.notEqual(cards[0], cards[1]);
  }
});

test("a swap never brings back a card the team holds, or the one it just gave back", () => {
  const random = seeded(9);
  for (let round = 0; round < 200; round += 1) {
    const pile = newPile(random).slice(0, 1 + (round % 5)); // nearly empty piles too
    const held = ["login", "captcha"];
    const result = swapCard(pile, held, round % 2, random);
    assert.ok(!held.includes(result.card));
    assert.equal(result.cards[round % 2], result.card);
    assert.equal(pile.at(-1), result.old, "the old card goes to the bottom");
  }
});

test("the stored pile deals the same cards again (that's how a restart deals what it would have)", () => {
  const random = seeded(4);
  const pile = newPile(random);
  const copy = [...pile];
  assert.deepEqual(drawCard(pile, new Set(), random).card, copy[0]);
  assert.deepEqual(drawCard([...copy], new Set([copy[0]]), random).card, copy[1]);
});

test("grouping the people waiting: new teams of three while there's room, then the smallest team with room", () => {
  const people = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, nameKey: `p${from + i}` }));
  const random = seeded(5);

  // Nobody has a team: 7 waiting, room for 10 teams → two new teams, sizes 4 and 3.
  let plan = groupPool(people(7), [], { maxTeams: 10, maxSize: 4, random });
  assert.deepEqual(plan.newTeams.map((t) => t.members.length).sort(), [3, 4]);
  assert.equal(plan.joins.length, 0);

  // Two waiting and teams already exist: they join the smallest teams, no new team of two.
  const teams = [
    { id: 10, size: 4, nameKeys: [] },
    { id: 11, size: 2, nameKeys: [] },
    { id: 12, size: 3, nameKeys: [] },
  ];
  plan = groupPool(people(2), teams, { maxTeams: 10, maxSize: 4, random });
  assert.equal(plan.newTeams.length, 0);
  assert.deepEqual(plan.joins.map((j) => j.teamId), [11, 11], "both go to the team of two");

  // No room for more teams: everyone joins existing ones, and a full house is flagged.
  plan = groupPool(people(5), [{ id: 1, size: 4, nameKeys: [] }, { id: 2, size: 4, nameKeys: [] }], { maxTeams: 2, maxSize: 4, random });
  assert.equal(plan.newTeams.length, 0);
  assert.equal(plan.joins.length, 5);
  assert.deepEqual(plan.over.sort(), [1, 2]);

  // Nobody joins a team with someone of the same name.
  plan = groupPool([{ id: 1, nameKey: "aisha" }], [{ id: 5, size: 1, nameKeys: ["aisha"] }, { id: 6, size: 3, nameKeys: [] }], { maxTeams: 2, maxSize: 4, random });
  assert.deepEqual(plan.joins, [{ personId: 1, teamId: 6 }]);

  // A single person and no teams at all: they become a team of one rather than waiting forever.
  plan = groupPool(people(1), [], { maxTeams: 4, maxSize: 4, random });
  assert.equal(plan.newTeams.length, 1);
});
