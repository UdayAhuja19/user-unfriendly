// Every change to the event: checked against the rules, then written in one transaction (with an
// audit row) before the server tells anyone. Each returns { ok: true, ... } or { error }.
//
// ctx = { store, ix (from event.index), now, random, scale }
// A phone's actions also get `me`: the person its device is bound to, or null.
import { nameKey, personName, teamName, teamCode, SWAP_MS, MAX_TEAMS_LIMIT, MAX_SIZE_LIMIT, MIN_SIZE_LIMIT } from "../../unfriendly/js/shared/rules.js";
import { acceptsJoins, canLeave, canRename, canSwap, hasRoom, isOpen, makeError } from "./event.js";
import { dealHand, groupPool, newCode, newPile, swapCard } from "./deck.js";

const UNDO_DEAL_MS = 2 * 60_000;

// A unique index refused the write: say which name clashed, in words.
function clash(err) {
  const text = String(err?.message ?? "");
  if (!text.includes("UNIQUE")) return null;
  if (text.includes("teams.name_key")) return "THAT TEAM NAME IS TAKEN.";
  if (text.includes("people")) return "SOMEONE HERE ALREADY HAS THAT NAME. ADD AN INITIAL.";
  return "THAT'S TAKEN. TRY ANOTHER.";
}

function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    const message = clash(err);
    if (message) return { error: message };
    throw err;
  }
}

const swapMs = (ctx) => Math.round(SWAP_MS * (ctx.scale ?? 1));

function pile(ctx) {
  return ctx.store.getMeta("deck_pile") ?? newPile(ctx.random);
}

// Deals one team its cards and opens its own swap window.
function dealTeam(ctx, teamId, cards) {
  const { store, now } = ctx;
  cards.forEach((card, slot) => store.run("INSERT INTO team_cards (team_id, slot, feature, dealt_at) VALUES (?, ?, ?, ?)", teamId, slot, card, now));
  store.run("UPDATE teams SET dealt_at = ?, swap_until = ? WHERE id = ?", now, now + swapMs(ctx), teamId);
}

function dealOne(ctx, teamId) {
  const draw = pile(ctx);
  const { cards, refilled } = dealHand(draw, ctx.random);
  dealTeam(ctx, teamId, cards);
  ctx.store.setMeta("deck_pile", draw);
  if (refilled) ctx.store.setMeta("deck_refills", (ctx.store.getMeta("deck_refills") ?? 0) + 1);
  return cards;
}

function takenCodes(ctx) {
  return new Set(ctx.store.all("SELECT code FROM teams").map((r) => r.code));
}

// The person this device should become: its old person if it has one and they're free.
function becomePerson(ctx, me, deviceId, fields) {
  const { store, now } = ctx;
  let id;
  if (me && me.role === "participant") {
    store.run("UPDATE people SET name = ?, name_key = ?, team_id = ?, pool_since = ? WHERE id = ?", fields.name, fields.key, fields.teamId, fields.poolSince, me.id);
    id = me.id;
  } else {
    id = Number(store.run("INSERT INTO people (role, name, name_key, team_id, pool_since, created_at) VALUES ('participant', ?, ?, ?, ?, ?)", fields.name, fields.key, fields.teamId, fields.poolSince, now).lastInsertRowid);
  }
  bindDevice(ctx, deviceId, id);
  return id;
}

export function bindDevice(ctx, deviceId, personId) {
  ctx.store.run(
    "INSERT INTO devices (client_id, person_id, bound_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET person_id = excluded.person_id, bound_at = excluded.bound_at, last_seen = excluded.last_seen",
    deviceId,
    personId,
    ctx.now,
    ctx.now
  );
}

// A participant who already has a team asks again (a resent message): nothing to do.
const alreadyIn = (me) => me && me.role === "participant" && me.team_id !== null;

// ---------- Phones ----------
// Every phone action is (ctx, me, deviceId, input).
export function make(ctx, me, deviceId, { name, team }) {
  if (alreadyIn(me)) return { ok: true, personId: me.id, already: true };
  const person = personName(name);
  if (person.error) return { error: person.error };
  const tn = teamName(team);
  if (tn.error) return { error: tn.error };
  const blocked = makeError(ctx.ix);
  if (blocked) return { error: blocked };
  if (ctx.ix.teams.some((t) => t.name_key === tn.key)) return { error: "THAT TEAM NAME IS TAKEN." };
  return guarded(() =>
    ctx.store.tx(() => {
      const code = newCode(takenCodes(ctx), ctx.random);
      const teamId = Number(ctx.store.run("INSERT INTO teams (code, name, name_key, origin, created_at) VALUES (?, ?, ?, 'made', ?)", code, tn.name, tn.key, ctx.now).lastInsertRowid);
      const personId = becomePerson(ctx, me, deviceId, { name: person.name, key: person.key, teamId, poolSince: null });
      ctx.store.run("UPDATE teams SET created_by = ? WHERE id = ?", personId, teamId);
      // Made after the deal: dealt straight away, with its own swap window.
      if (ctx.ix.phase === "deal") dealOne(ctx, teamId);
      ctx.store.audit(`person:${personId}`, "make", { team: tn.name, code });
      return { ok: true, personId, teamId };
    })
  );
}

export function join(ctx, me, deviceId, { name, code }) {
  if (alreadyIn(me)) return { ok: true, personId: me.id, already: true };
  const person = personName(name);
  if (person.error) return { error: person.error };
  const clean = teamCode(code);
  const team = clean ? ctx.ix.teams.find((t) => t.code === clean) : null;
  if (!team) return { error: "NO TEAM HAS THAT CODE. CHECK IT WITH YOUR TEAM.", wrongCode: true };
  if (!acceptsJoins(ctx.ix, team)) return { error: "TEAMS ARE LOCKED. ASK AN ORGANISER." };
  if (!hasRoom(ctx.ix, team)) return { error: `${team.name.toUpperCase()} IS FULL (${ctx.ix.maxSize}). JOIN ANOTHER, OR TAP FIND ME A TEAM.` };
  return guarded(() =>
    ctx.store.tx(() => {
      const personId = becomePerson(ctx, me, deviceId, { name: person.name, key: person.key, teamId: team.id, poolSince: null });
      ctx.store.audit(`person:${personId}`, "join", { team: team.name });
      return { ok: true, personId, teamId: team.id };
    })
  );
}

export function pool(ctx, me, deviceId, { name }) {
  if (alreadyIn(me)) return { ok: true, personId: me.id, already: true };
  if (me && me.pool_since !== null) return { ok: true, personId: me.id, already: true };
  const person = personName(name);
  if (person.error) return { error: person.error };
  if (!isOpen(ctx.ix)) return { error: "TEAMS ARE LOCKED. ASK AN ORGANISER." };
  return guarded(() =>
    ctx.store.tx(() => {
      const personId = becomePerson(ctx, me, deviceId, { name: person.name, key: person.key, teamId: null, poolSince: ctx.now });
      ctx.store.audit(`person:${personId}`, "pool", null);
      return { ok: true, personId };
    })
  );
}

export function leave(ctx, me) {
  if (!me || me.team_id === null) return { ok: true };
  if (!canLeave(ctx.ix)) return { error: "TEAMS ARE SET NOW. ASK AN ORGANISER TO MOVE YOU." };
  const teamId = me.team_id;
  return ctx.store.tx(() => {
    ctx.store.run("UPDATE people SET team_id = NULL, pool_since = NULL WHERE id = ?", me.id);
    const left = ctx.store.get("SELECT COUNT(*) AS n FROM people WHERE team_id = ? AND removed_at IS NULL", teamId).n;
    if (left === 0) ctx.store.run("UPDATE teams SET removed_at = ? WHERE id = ?", ctx.now, teamId);
    ctx.store.audit(`person:${me.id}`, "leave", { teamId, emptied: left === 0 });
    return { ok: true };
  });
}

export function rename(ctx, me, deviceId, { team }) {
  if (!me || me.team_id === null) return { error: "YOU'RE NOT IN A TEAM." };
  if (!canRename(ctx.ix)) return { error: "TEAM NAMES ARE SET NOW." };
  const tn = teamName(team);
  if (tn.error) return { error: tn.error };
  if (ctx.ix.teams.some((t) => t.name_key === tn.key && t.id !== me.team_id)) return { error: "THAT TEAM NAME IS TAKEN." };
  return guarded(() =>
    ctx.store.tx(() => {
      ctx.store.run("UPDATE teams SET name = ?, name_key = ? WHERE id = ?", tn.name, tn.key, me.team_id);
      ctx.store.audit(`person:${me.id}`, "rename", { team: tn.name });
      return { ok: true };
    })
  );
}

export function swap(ctx, me, deviceId, { slot }) {
  if (!me || me.team_id === null) return { error: "YOU'RE NOT IN A TEAM." };
  const team = ctx.ix.teamById.get(me.team_id);
  if (!team || team.dealt_at === null) return { error: "NO CARDS YET." };
  if (team.swapped_at !== null) return { ok: true, already: true };
  if (!Number.isInteger(slot) || slot < 0 || slot >= team.cards.length) return { error: "PICK A CARD TO SWAP." };
  if (!canSwap(ctx.ix, team, ctx.now)) return { error: "THE SWAP WINDOW HAS CLOSED." };
  return ctx.store.tx(() => {
    const draw = pile(ctx);
    const result = swapCard(draw, team.cards, slot, ctx.random);
    ctx.store.run("UPDATE team_cards SET feature = ?, replaced = ? WHERE team_id = ? AND slot = ?", result.card, result.old, team.id, slot);
    ctx.store.run("UPDATE teams SET swapped_at = ? WHERE id = ?", ctx.now, team.id);
    ctx.store.setMeta("deck_pile", draw);
    if (result.refilled) ctx.store.setMeta("deck_refills", (ctx.store.getMeta("deck_refills") ?? 0) + 1);
    ctx.store.audit(`person:${me.id}`, "swap", { team: team.name, from: result.old, to: result.card });
    return { ok: true, from: result.old, to: result.card };
  });
}

// ---------- Getting back in on a new address ----------
// A team code shows who's in that team, so you can tap your own name.
export function lookup(ctx, { code }) {
  const clean = teamCode(code);
  const team = clean ? ctx.ix.teams.find((t) => t.code === clean) : null;
  if (!team) return { error: "NO TEAM HAS THAT CODE. CHECK IT WITH YOUR TEAM.", wrongCode: true };
  return {
    ok: true,
    team: { name: team.name, code: team.code, canJoin: acceptsJoins(ctx.ix, team) && hasRoom(ctx.ix, team), members: (ctx.ix.members.get(team.id) ?? []).map((p) => ({ id: p.id, name: p.name })) },
  };
}

// No code? Your exact name (accents and case don't matter) finds you.
export function findByName(ctx, { name }) {
  const person = personName(name);
  if (person.error) return { error: person.error };
  const found = ctx.ix.people
    .filter((p) => p.role === "participant" && p.name_key === person.key)
    .map((p) => ({ id: p.id, name: p.name, team: p.team_id === null ? null : ctx.ix.teamById.get(p.team_id)?.name ?? null }));
  if (found.length === 0) return { error: "NOBODY BY THAT NAME. TYPE IT THE WAY YOU DID AT THE START.", wrongCode: true };
  return { ok: true, found };
}

// Binds this device to someone found by code or by name. `proof` is the code or the name typed.
export function claim(ctx, deviceId, { personId, code, name }) {
  const person = ctx.ix.personById.get(personId);
  if (!person || person.role !== "participant") return { error: "THAT PERSON ISN'T HERE ANY MORE." };
  if (code !== undefined) {
    const team = person.team_id === null ? null : ctx.ix.teamById.get(person.team_id);
    if (!team || team.code !== teamCode(code)) return { error: "THAT CODE ISN'T FOR THIS TEAM.", wrongCode: true };
  } else {
    const typed = personName(name);
    if (typed.error || typed.key !== person.name_key) return { error: "THAT NAME DOESN'T MATCH.", wrongCode: true };
  }
  return ctx.store.tx(() => {
    bindDevice(ctx, deviceId, person.id);
    ctx.store.audit(`person:${person.id}`, "claim", { device: deviceId.slice(0, 8) });
    return { ok: true, personId: person.id };
  });
}

// ---------- The host ----------
export function settings(ctx, { maxTeams, maxSize }) {
  const { store, ix } = ctx;
  const changes = {};
  if (maxTeams !== undefined) {
    if (!Number.isInteger(maxTeams) || maxTeams < 1 || maxTeams > MAX_TEAMS_LIMIT) return { error: `TEAMS: 1 TO ${MAX_TEAMS_LIMIT}.` };
    if (maxTeams < ix.teams.length) return { error: `THERE ARE ALREADY ${ix.teams.length} TEAMS. REMOVE SOME FIRST.` };
    changes.max_teams = maxTeams;
  }
  if (maxSize !== undefined) {
    if (!Number.isInteger(maxSize) || maxSize < MIN_SIZE_LIMIT || maxSize > MAX_SIZE_LIMIT) return { error: `TEAM SIZE: ${MIN_SIZE_LIMIT} TO ${MAX_SIZE_LIMIT}.` };
    changes.max_size = maxSize;
  }
  return store.tx(() => {
    for (const [key, value] of Object.entries(changes)) store.setMeta(key, value);
    store.audit("host", "settings", changes);
    return { ok: true };
  });
}

function groupPlan(ctx) {
  const { ix } = ctx;
  return groupPool(
    ix.pool.map((p) => ({ id: p.id, nameKey: p.name_key })),
    ix.teams.map((t) => ({ id: t.id, size: ix.members.get(t.id)?.length ?? 0, nameKeys: (ix.members.get(t.id) ?? []).map((p) => p.name_key) })),
    { maxTeams: ix.maxTeams, maxSize: ix.maxSize, takenNames: new Set(ix.teams.map((t) => t.name_key)) }
  );
}

// Who goes where, in words, for the host to confirm.
function describeGroup(ctx, plan) {
  const name = (id) => ctx.ix.personById.get(id)?.name ?? "?";
  const lines = [];
  for (const t of plan.newTeams) lines.push(`NEW ${t.name.toUpperCase()}: ${t.members.map(name).join(", ")}`);
  for (const j of plan.joins) lines.push(`${name(j.personId)} → ${ctx.ix.teamById.get(j.teamId)?.name ?? "?"}`);
  for (const id of plan.stuck) lines.push(`${name(id)}: NO TEAM FITS`);
  return lines;
}

export function group(ctx, { dryRun }) {
  const { ix } = ctx;
  if (!isOpen(ix)) return { error: "TEAMS ARE LOCKED." };
  if (ix.pool.length === 0) return { error: "NOBODY IS WAITING FOR A TEAM." };
  const plan = groupPlan(ctx);
  const lines = describeGroup(ctx, plan);
  if (dryRun) return { ok: true, lines, over: plan.over.map((id) => ix.teamById.get(id)?.name) };
  return guarded(() =>
    ctx.store.tx(() => {
      const taken = takenCodes(ctx);
      for (const t of plan.newTeams) {
        const code = newCode(taken, ctx.random);
        taken.add(code);
        const teamId = Number(ctx.store.run("INSERT INTO teams (code, name, name_key, origin, created_at) VALUES (?, ?, ?, 'pool', ?)", code, t.name, nameKey(t.name), ctx.now).lastInsertRowid);
        for (const personId of t.members) ctx.store.run("UPDATE people SET team_id = ?, pool_since = NULL WHERE id = ?", teamId, personId);
        if (ix.phase === "deal") dealOne(ctx, teamId);
      }
      for (const j of plan.joins) ctx.store.run("UPDATE people SET team_id = ?, pool_since = NULL WHERE id = ?", j.teamId, j.personId);
      ctx.store.audit("host", "group", { lines });
      return { ok: true, lines };
    })
  );
}

export function deal(ctx) {
  const { ix, store } = ctx;
  if (ix.phase !== "join") return { error: "THE CARDS ARE ALREADY DEALT." };
  if (ix.teams.length === 0) return { error: "THERE ARE NO TEAMS YET." };
  if (ix.pool.length > 0) return { error: `${ix.pool.length} ${ix.pool.length === 1 ? "PERSON IS" : "PEOPLE ARE"} STILL WAITING FOR A TEAM. GROUP THEM FIRST.` };
  const empty = ix.teams.filter((t) => (ix.members.get(t.id)?.length ?? 0) === 0);
  if (empty.length > 0) return { error: `${empty.map((t) => t.name).join(", ")} HAS NOBODY IN IT. REMOVE IT FIRST.` };
  return store.tx(() => {
    const draw = pile(ctx);
    store.setMeta("deck_before_deal", [...draw]);
    store.setMeta("refills_before_deal", store.getMeta("deck_refills") ?? 0);
    let refills = store.getMeta("deck_refills") ?? 0;
    for (const team of ix.teams) {
      const { cards, refilled } = dealHand(draw, ctx.random);
      if (refilled) refills += 1;
      dealTeam(ctx, team.id, cards);
    }
    store.setMeta("deck_pile", draw);
    store.setMeta("deck_refills", refills);
    store.setMeta("phase", "deal");
    store.setMeta("phase_at", ctx.now);
    store.setMeta("deal_at", ctx.now);
    store.audit("host", "deal", { teams: ix.teams.length });
    return { ok: true, phaseChanged: true };
  });
}

export function undoDeal(ctx) {
  const { ix, store } = ctx;
  if (ix.phase !== "deal") return { error: "NOTHING TO UNDO." };
  if (ctx.now - (ix.meta.deal_at ?? 0) > UNDO_DEAL_MS) return { error: "TOO LATE TO UNDO THE DEAL." };
  if (ix.teams.some((t) => t.swapped_at !== null)) return { error: "A TEAM HAS ALREADY SWAPPED. TOO LATE TO UNDO." };
  return store.tx(() => {
    store.run("DELETE FROM team_cards");
    store.run("UPDATE teams SET dealt_at = NULL, swap_until = NULL, swapped_at = NULL");
    store.setMeta("deck_pile", store.getMeta("deck_before_deal"));
    store.setMeta("deck_refills", store.getMeta("refills_before_deal") ?? 0);
    store.setMeta("phase", "join");
    store.setMeta("phase_at", ctx.now);
    store.setMeta("deal_at", null);
    store.audit("host", "undoDeal", null);
    return { ok: true, phaseChanged: true };
  });
}

export function reopenSwap(ctx, { teamId, ms }) {
  const team = ctx.ix.teamById.get(teamId);
  if (!team || team.dealt_at === null) return { error: "THAT TEAM HASN'T BEEN DEALT." };
  if (team.swapped_at !== null) return { error: "THAT TEAM HAS ALREADY SWAPPED." };
  if (ctx.ix.phase !== "deal" && ctx.ix.phase !== "build") return { error: "SWAPS ARE OVER ONCE PRESENTING STARTS." };
  if (!Number.isInteger(ms) || ms < 10_000 || ms > 15 * 60_000) return { error: "BETWEEN 10 SECONDS AND 15 MINUTES." };
  return ctx.store.tx(() => {
    ctx.store.run("UPDATE teams SET swap_until = ? WHERE id = ?", ctx.now + ms, team.id);
    ctx.store.audit("host", "reopenSwap", { team: team.name, ms });
    return { ok: true };
  });
}

export function buildStart(ctx, { minutes }) {
  const { ix, store } = ctx;
  if (ix.phase !== "deal") return { error: ix.phase === "join" ? "DEAL THE CARDS FIRST." : "THE BUILD HAS ALREADY STARTED." };
  if (typeof minutes !== "number" || !(minutes >= 1 && minutes <= 180)) return { error: "BUILD TIME: 1 TO 180 MINUTES." };
  const ms = Math.round(minutes * 60_000 * (ctx.scale ?? 1));
  return store.tx(() => {
    store.setMeta("build_start_at", ctx.now);
    store.setMeta("build_end_at", ctx.now + ms);
    store.setMeta("clock_version", 1);
    store.setMeta("phase", "build");
    store.setMeta("phase_at", ctx.now);
    store.audit("host", "buildStart", { minutes });
    return { ok: true, phaseChanged: true };
  });
}

// Moves the end of the build. Kept within 3 hours of now.
export function nudge(ctx, { ms }) {
  const { ix, store } = ctx;
  if (ix.phase !== "build") return { error: "THE BUILD ISN'T ON." };
  if (!Number.isInteger(ms) || Math.abs(ms) > 60 * 60_000) return { error: "MOVE IT BY AN HOUR AT MOST." };
  const end = Math.min(ctx.now + 3 * 60 * 60_000, Math.max(ix.meta.build_start_at, (ix.meta.build_end_at ?? ctx.now) + ms));
  return store.tx(() => {
    store.setMeta("build_end_at", end);
    // Open links never lock before pencils down: a later end takes the lock with it.
    if (ix.meta.links_close_at != null && ix.meta.links_close_at < end) store.setMeta("links_close_at", end);
    store.setMeta("clock_version", (ix.meta.clock_version ?? 1) + 1);
    store.audit("host", "nudge", { ms, end });
    return { ok: true, endAt: end };
  });
}

export function editPerson(ctx, { id, certName, teamId, remove }) {
  const { ix, store } = ctx;
  const person = ix.personById.get(id);
  if (!person) return { error: "THAT PERSON ISN'T HERE ANY MORE." };
  if (remove === true) {
    return store.tx(() => {
      store.run("UPDATE people SET removed_at = ? WHERE id = ?", ctx.now, id);
      store.run("DELETE FROM devices WHERE person_id = ?", id);
      store.audit("host", "removePerson", { name: person.name });
      return { ok: true, removed: id };
    });
  }
  if (certName !== undefined) {
    const checked = personName(certName);
    if (checked.error) return { error: checked.error };
    return store.tx(() => {
      store.run("UPDATE people SET cert_name = ? WHERE id = ?", checked.name === person.name ? null : checked.name, id);
      store.audit("host", "certName", { name: person.name, cert: checked.name });
      return { ok: true };
    });
  }
  if (teamId !== undefined) {
    if (teamId !== null && !ix.teamById.has(teamId)) return { error: "THAT TEAM ISN'T HERE ANY MORE." };
    return guarded(() =>
      store.tx(() => {
        store.run("UPDATE people SET team_id = ?, pool_since = NULL WHERE id = ?", teamId, id);
        store.audit("host", "movePerson", { name: person.name, to: teamId === null ? null : ix.teamById.get(teamId).name });
        return { ok: true };
      })
    );
  }
  return { error: "NOTHING TO CHANGE." };
}

// The host adds a team at any point before the results: one that turns up late or forms on the spot.
// It gets a code, its feature (once the deal has happened) and, if presenting has started, the last
// slot in the running order. Members can be typed in now (they get back in with the code and their
// name) or join from their phones with the code: a host-added team accepts joins until the results.
export function addTeam(ctx, { name, members = [] }) {
  const { ix, store, now } = ctx;
  if (ix.phase === "results") return { error: "THE RESULTS ARE OUT." };
  const tn = teamName(name);
  if (tn.error) return { error: tn.error };
  if (!Array.isArray(members) || members.length > ix.maxSize) return { error: `UP TO ${ix.maxSize} PEOPLE IN A TEAM.` };
  const people = members.map((m) => personName(m));
  const bad = people.find((p) => p.error);
  if (bad) return { error: bad.error };
  if (new Set(people.map((p) => p.key)).size !== people.length) return { error: "TWO OF THEM HAVE THE SAME NAME." };
  return guarded(() =>
    store.tx(() => {
      const code = newCode(takenCodes(ctx), ctx.random);
      const teamId = Number(store.run("INSERT INTO teams (code, name, name_key, origin, created_at) VALUES (?, ?, ?, 'host', ?)", code, tn.name, tn.key, now).lastInsertRowid);
      for (const p of people) store.run("INSERT INTO people (role, name, name_key, team_id, created_at) VALUES ('participant', ?, ?, ?, ?)", p.name, p.key, teamId, now);
      if (ix.phase !== "join") dealOne(ctx, teamId);
      if (ix.phase === "present") {
        const last = store.all("SELECT MAX(slot) AS m FROM demos")[0]?.m ?? -1;
        store.run("INSERT INTO demos (slot, team_id) VALUES (?, ?)", last + 1, teamId);
      }
      store.audit("host", "addTeam", { name: tn.name, members: people.length, phase: ix.phase });
      return { ok: true, code, teamId };
    })
  );
}

export function editTeam(ctx, { id, name, remove }) {
  const { ix, store } = ctx;
  const team = ix.teamById.get(id);
  if (!team) return { error: "THAT TEAM ISN'T HERE ANY MORE." };
  if (remove === true) {
    if (!isOpen(ix)) return { error: "TEAMS ARE LOCKED NOW." };
    return store.tx(() => {
      store.run("UPDATE people SET team_id = NULL, pool_since = ? WHERE team_id = ? AND removed_at IS NULL", ctx.now, id);
      store.run("UPDATE teams SET removed_at = ? WHERE id = ?", ctx.now, id);
      store.audit("host", "removeTeam", { name: team.name });
      return { ok: true };
    });
  }
  const tn = teamName(name);
  if (tn.error) return { error: tn.error };
  return guarded(() =>
    store.tx(() => {
      store.run("UPDATE teams SET name = ?, name_key = ? WHERE id = ?", tn.name, tn.key, id);
      store.audit("host", "renameTeam", { from: team.name, to: tn.name });
      return { ok: true };
    })
  );
}

