// The second half of the event: links, presenting, judges, stickers and results. Same shape as
// commands.js: checked, written in one transaction with an audit row, then { ok } or { error }.
import { personName, siteUrl, teamCode, PIN_PATTERN, isQuest, stickerKind, QUEST_EACH, JOKES_PER_TEAM, RATINGS } from "../../unfriendly/js/shared/rules.js";
import { linksWindow, hasPresented, rateable, stickersOpen, demoLength } from "./event.js";
import { shuffled } from "./deck.js";
import { computeResults } from "./results.js";
import { bindDevice } from "./commands.js";

const PRESENT_BUDGET_MS = 40 * 60_000;
const clash = (err) => String(err?.message ?? "").includes("UNIQUE");

// ---------- Links ----------
// A phone sends its team's link: a team member's phone knows its team; a new phone gives the code.
export function link(ctx, me, deviceId, { code, url }) {
  const { ix, now, store } = ctx;
  if (!linksWindow(ix, now).open) return { error: "LINKS AREN'T OPEN. WATCH THE BIG SCREEN." };
  let team = me?.role === "participant" && me.team_id !== null ? ix.teamById.get(me.team_id) : null;
  if (!team) {
    const clean = teamCode(code);
    team = clean ? ix.teams.find((t) => t.code === clean) : null;
    if (!team) return { error: "NO TEAM HAS THAT CODE. CHECK IT WITH YOUR TEAM.", wrongCode: true };
  }
  const checked = siteUrl(url);
  if (checked.error) return { error: checked.error };
  return store.tx(() => {
    store.run("UPDATE teams SET link_url = ?, link_kind = 'url', link_at = ?, link_by = ? WHERE id = ?", checked.url, now, me ? `person:${me.id}` : `device:${deviceId.slice(0, 8)}`, team.id);
    store.audit(me ? `person:${me.id}` : "phone", "link", { team: team.name, host: checked.host });
    return { ok: true, team: team.name, host: checked.host };
  });
}

export function hostLink(ctx, { teamId, url, ownLaptop }) {
  const team = ctx.ix.teamById.get(teamId);
  if (!team) return { error: "THAT TEAM ISN'T HERE ANY MORE." };
  if (ownLaptop === true) {
    return ctx.store.tx(() => {
      ctx.store.run("UPDATE teams SET link_url = NULL, link_kind = 'own-laptop', link_at = ?, link_by = 'host' WHERE id = ?", ctx.now, team.id);
      ctx.store.audit("host", "link", { team: team.name, ownLaptop: true });
      return { ok: true };
    });
  }
  const checked = siteUrl(url);
  if (checked.error) return { error: checked.error };
  return ctx.store.tx(() => {
    ctx.store.run("UPDATE teams SET link_url = ?, link_kind = 'url', link_at = ?, link_by = 'host' WHERE id = ?", checked.url, ctx.now, team.id);
    ctx.store.audit("host", "link", { team: team.name, host: checked.host });
    return { ok: true };
  });
}

export function linksOpen(ctx) {
  const { ix, store, now } = ctx;
  if (ix.phase !== "build") return { error: "LINKS OPEN DURING THE BUILD." };
  return store.tx(() => {
    store.setMeta("links_open_at", now);
    // Open until pencils down, or a few minutes if pencils down has already passed.
    store.setMeta("links_close_at", Math.max(ix.meta.build_end_at ?? now, now + 5 * 60_000 * (ctx.scale ?? 1)));
    store.audit("host", "linksOpen", null);
    return { ok: true };
  });
}

export function linksExtend(ctx, { ms }) {
  const { ix, store, now } = ctx;
  if (!ix.meta.links_open_at) return { error: "OPEN THE LINKS FIRST." };
  if (!Number.isInteger(ms) || ms <= 0 || ms > 30 * 60_000) return { error: "UP TO 30 MINUTES." };
  const close = Math.max(linksWindow(ix, now).closeAt ?? now, now) + ms;
  return store.tx(() => {
    store.setMeta("links_close_at", close);
    store.audit("host", "linksExtend", { ms });
    return { ok: true };
  });
}

// ---------- Presenting ----------
export function presentStart(ctx, { minutes }) {
  const { ix, store, now } = ctx;
  if (ix.phase !== "build") return { error: ix.phase === "present" ? "PRESENTING HAS STARTED." : "START THE BUILD FIRST." };
  const teams = ix.teams.filter((t) => (ix.members.get(t.id)?.length ?? 0) > 0);
  if (teams.length === 0) return { error: "THERE ARE NO TEAMS." };
  const budget = typeof minutes === "number" && minutes >= 1 && minutes <= 180 ? Math.round(minutes * 60_000 * (ctx.scale ?? 1)) : Math.round(PRESENT_BUDGET_MS * (ctx.scale ?? 1));
  // Teams the host added (late arrivals) go last, so they get the most time to build.
  const order = [...shuffled(teams.filter((t) => t.origin !== "host").map((t) => t.id), ctx.random), ...shuffled(teams.filter((t) => t.origin === "host").map((t) => t.id), ctx.random)];
  return store.tx(() => {
    store.run("DELETE FROM demos");
    order.forEach((teamId, slot) => store.run("INSERT INTO demos (slot, team_id) VALUES (?, ?)", slot, teamId));
    store.setMeta("phase", "present");
    store.setMeta("phase_at", now);
    store.setMeta("present_at", now);
    store.setMeta("present_budget_ms", budget);
    store.setMeta("demo_ms", demoLength(budget, order.length, ctx.scale ?? 1));
    store.setMeta("current_slot", 0);
    store.audit("host", "presentStart", { teams: order.length, budget });
    return { ok: true, phaseChanged: true };
  });
}

export function demoStart(ctx) {
  const { ix, store, now } = ctx;
  if (ix.phase !== "present") return { error: "PRESENTING HASN'T STARTED." };
  const demo = ix.demos.find((d) => d.slot === ix.currentSlot);
  if (!demo) return { error: "EVERY TEAM HAS PRESENTED." };
  const ms = ix.meta.demo_ms ?? 120_000;
  return store.tx(() => {
    // Pressed again while running: the demo starts over (a restart, a false start).
    store.run("UPDATE demos SET started_at = ?, ends_at = ?, ended_at = NULL WHERE slot = ?", now, now + ms, demo.slot);
    store.audit("host", "demoStart", { slot: demo.slot });
    return { ok: true };
  });
}

export function next(ctx) {
  const { ix, store, now } = ctx;
  if (ix.phase !== "present") return { error: "PRESENTING HASN'T STARTED." };
  const demo = ix.demos.find((d) => d.slot === ix.currentSlot);
  if (!demo) return { error: "EVERY TEAM HAS PRESENTED." };
  return store.tx(() => {
    store.run("UPDATE demos SET ended_at = ?, skipped = ? WHERE slot = ?", now, demo.started_at === null ? 1 : 0, demo.slot);
    store.setMeta("current_slot", ix.currentSlot + 1);
    store.audit("host", "next", { slot: demo.slot, skipped: demo.started_at === null });
    return { ok: true };
  });
}

// A team that isn't ready goes to the end of the running order.
export function toEnd(ctx, { teamId }) {
  const { ix, store } = ctx;
  const demo = ix.demos.find((d) => d.team_id === teamId);
  if (!demo || demo.slot < ix.currentSlot || (demo.slot === ix.currentSlot && demo.started_at !== null)) return { error: "THAT TEAM HAS ALREADY PRESENTED." };
  const later = ix.demos.filter((d) => d.slot > demo.slot);
  if (later.length === 0) return { error: "THEY'RE ALREADY LAST." };
  return store.tx(() => {
    // Slots are unique, so shuffle everything after it up one through a temporary slot.
    store.run("UPDATE demos SET slot = -1 WHERE team_id = ?", teamId);
    for (const d of later) store.run("UPDATE demos SET slot = ? WHERE team_id = ?", d.slot - 1, d.team_id);
    store.run("UPDATE demos SET slot = ?, started_at = NULL, ends_at = NULL, ended_at = NULL WHERE team_id = ?", ix.demos.length - 1, teamId);
    store.audit("host", "toEnd", { team: ix.teamById.get(teamId)?.name });
    return { ok: true };
  });
}

export function setDemoLength(ctx, { seconds }) {
  if (ctx.ix.phase !== "present") return { error: "PRESENTING HASN'T STARTED." };
  if (!Number.isInteger(seconds) || seconds < 20 || seconds > 600) return { error: "20 SECONDS TO 10 MINUTES." };
  return ctx.store.tx(() => {
    ctx.store.setMeta("demo_ms", Math.round(seconds * 1000 * (ctx.scale ?? 1)));
    ctx.store.audit("host", "demoLength", { seconds });
    return { ok: true };
  });
}

// ---------- Judges ----------
function pinOk(ctx, pin) {
  return typeof pin === "string" && PIN_PATTERN.test(pin) && pin === ctx.ix.meta.judge_pin;
}

export function judgeList(ctx, { pin }) {
  if (!pinOk(ctx, pin)) return { error: "THAT PIN ISN'T RIGHT. IT'S IN THE ORGANISERS' GROUP.", wrongCode: true };
  return { ok: true, judges: ctx.ix.judges.map((j) => ({ id: j.id, name: j.name })) };
}

export function judgeNew(ctx, me, deviceId, { pin, name }) {
  if (me?.role === "judge") return { ok: true, personId: me.id, already: true };
  if (!pinOk(ctx, pin)) return { error: "THAT PIN ISN'T RIGHT. IT'S IN THE ORGANISERS' GROUP.", wrongCode: true };
  const checked = personName(name);
  if (checked.error) return { error: checked.error };
  try {
    return ctx.store.tx(() => {
      const id = Number(ctx.store.run("INSERT INTO people (role, name, name_key, created_at) VALUES ('judge', ?, ?, ?)", checked.name, checked.key, ctx.now).lastInsertRowid);
      bindDevice(ctx, deviceId, id);
      ctx.store.audit(`person:${id}`, "judgeNew", null);
      return { ok: true, personId: id };
    });
  } catch (err) {
    if (clash(err)) return { error: "A JUDGE WITH THAT NAME IS ALREADY IN. TAP YOUR NAME, OR ADD AN INITIAL." };
    throw err;
  }
}

export function judgeClaim(ctx, deviceId, { pin, personId }) {
  if (!pinOk(ctx, pin)) return { error: "THAT PIN ISN'T RIGHT.", wrongCode: true };
  const judge = ctx.ix.personById.get(personId);
  if (!judge || judge.role !== "judge") return { error: "THAT JUDGE ISN'T HERE ANY MORE." };
  return ctx.store.tx(() => {
    bindDevice(ctx, deviceId, judge.id);
    ctx.store.audit(`person:${judge.id}`, "judgeClaim", null);
    return { ok: true, personId: judge.id };
  });
}

export function rate(ctx, me, deviceId, { team, value }) {
  if (me?.role !== "judge") return { error: "ONLY JUDGES RATE." };
  if (!Number.isInteger(value) || value < 1 || value > RATINGS.length) return { error: "PICK ONE OF THE SIX." };
  const window = rateable(ctx.ix, me.id, team, ctx.now);
  if (!window) return { error: "VOTING FOR THAT TEAM HAS CLOSED." };
  return ctx.store.tx(() => {
    ctx.store.run(
      "INSERT INTO ratings (judge_id, team_id, value, first_at, updated_at, late) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(judge_id, team_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      me.id,
      team,
      value,
      ctx.now,
      ctx.now,
      window.late ? 1 : 0
    );
    ctx.store.audit(`person:${me.id}`, "rate", { team, value, late: window.late });
    return { ok: true };
  });
}

// ---------- Stickers ----------
// Someone who isn't in a team (or doesn't want to say who they are) joins just for stickers.
// They say which team they're in, if any, so they can't sticker it.
export function audience(ctx, me, deviceId, { name, ownTeam }) {
  if (me && (me.role === "audience" || me.role === "participant")) return { ok: true, personId: me.id, already: true };
  if (!stickersOpen(ctx.ix)) return { error: "STICKERS OPEN WHEN PRESENTING STARTS." };
  const checked = personName(name);
  if (checked.error) return { error: checked.error };
  const own = ownTeam === null || ownTeam === undefined ? null : ctx.ix.teamById.get(ownTeam) ? ownTeam : undefined;
  if (own === undefined) return { error: "PICK YOUR TEAM, OR NOT IN A TEAM." };
  try {
    return ctx.store.tx(() => {
      const id = Number(ctx.store.run("INSERT INTO people (role, name, name_key, own_team_id, created_at) VALUES ('audience', ?, ?, ?, ?)", checked.name, checked.key, own, ctx.now).lastInsertRowid);
      bindDevice(ctx, deviceId, id);
      ctx.store.audit(`person:${id}`, "audience", { ownTeam: own });
      return { ok: true, personId: id };
    });
  } catch (err) {
    if (clash(err)) return { error: "SOMEONE HAS THAT NAME ALREADY. ADD AN INITIAL." };
    throw err;
  }
}

const ownTeamOf = (me) => (me.role === "participant" ? me.team_id : me.own_team_id ?? null);
const spot = (n) => Number.isInteger(n) && n >= 0 && n <= 1000;

function stickerAllowed(ctx, me, teamId) {
  if (!me || (me.role !== "participant" && me.role !== "audience")) return "JOIN FIRST.";
  if (!stickersOpen(ctx.ix)) return "STICKERS ARE CLOSED.";
  if (!ctx.ix.teamById.has(teamId) || !hasPresented(ctx.ix, teamId)) return "THAT TEAM HASN'T PRESENTED YET.";
  if (ownTeamOf(me) === teamId) return "NOT YOUR OWN TEAM.";
  return null;
}

// Stickers don't change the event's core, so these return what changed for the server to pass on.
export function slap(ctx, me, deviceId, { op, team, kind, x, y }) {
  const refused = stickerAllowed(ctx, me, team);
  if (refused) return { error: refused };
  const meta = stickerKind(kind);
  if (!meta || !spot(x) || !spot(y)) return { error: "THAT STICKER DIDN'T STICK." };
  const { store, now } = ctx;
  const quest = isQuest(kind) ? 1 : 0;
  return store.tx(() => {
    const again = store.get("SELECT * FROM stickers WHERE person_id = ? AND op = ?", me.id, op);
    if (again) return { ok: true, already: true };
    if (quest) {
      const used = store.get("SELECT COUNT(*) AS n FROM stickers WHERE person_id = ? AND kind = ? AND removed_at IS NULL", me.id, kind).n;
      if (used >= QUEST_EACH) return { error: QUEST_EACH === 1 ? `YOU'VE USED YOUR ${meta.name.toUpperCase()} STICKER. PEEL IT OFF TO MOVE IT.` : `YOU'VE USED ALL ${QUEST_EACH} ${meta.name.toUpperCase()} STICKERS. PEEL ONE OFF TO MOVE IT.` };
    } else {
      const jokes = store.get("SELECT COUNT(*) AS n FROM stickers WHERE person_id = ? AND team_id = ? AND quest = 0 AND removed_at IS NULL", me.id, team).n;
      if (jokes >= JOKES_PER_TEAM) return { error: `${JOKES_PER_TEAM} JOKE STICKERS PER TEAM. THAT'S PLENTY.` };
    }
    const id = Number(store.run("INSERT INTO stickers (person_id, team_id, kind, quest, x, y, op, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", me.id, team, kind, quest, x, y, op, now).lastInsertRowid);
    return { ok: true, sticker: { id, team, kind, x, y, by: me.id } };
  });
}

export function move(ctx, me, deviceId, { id, team, x, y }) {
  const { store, now } = ctx;
  const row = Number.isInteger(id) ? store.get("SELECT * FROM stickers WHERE id = ? AND removed_at IS NULL", id) : null;
  if (!row || row.person_id !== me?.id) return { error: "THAT ISN'T YOUR STICKER." };
  const refused = stickerAllowed(ctx, me, team);
  if (refused) return { error: refused };
  if (!spot(x) || !spot(y)) return { error: "THAT STICKER DIDN'T STICK." };
  if (!row.quest && team !== row.team_id) {
    const jokes = store.get("SELECT COUNT(*) AS n FROM stickers WHERE person_id = ? AND team_id = ? AND quest = 0 AND removed_at IS NULL", me.id, team).n;
    if (jokes >= JOKES_PER_TEAM) return { error: `${JOKES_PER_TEAM} JOKE STICKERS PER TEAM. THAT'S PLENTY.` };
  }
  return store.tx(() => {
    store.run("UPDATE stickers SET team_id = ?, x = ?, y = ?, moved_at = ? WHERE id = ?", team, x, y, now, id);
    return { ok: true, moved: { id, from: row.team_id, team, kind: row.kind, x, y, by: me.id } };
  });
}

export function peel(ctx, me, deviceId, { id }) {
  const { store, now } = ctx;
  const row = Number.isInteger(id) ? store.get("SELECT * FROM stickers WHERE id = ? AND removed_at IS NULL", id) : null;
  if (!row || row.person_id !== me?.id) return { error: "THAT ISN'T YOUR STICKER." };
  if (!stickersOpen(ctx.ix)) return { error: "STICKERS ARE CLOSED." };
  return store.tx(() => {
    store.run("UPDATE stickers SET removed_at = ? WHERE id = ?", now, id);
    return { ok: true, peeled: { id, team: row.team_id } };
  });
}

// ---------- Results ----------
// Stickers close and the results are worked out once, then frozen, so a restart shows the same.
export function resultsStart(ctx) {
  const { ix, store, now } = ctx;
  if (ix.phase !== "present") return { error: "PRESENTING HASN'T STARTED." };
  const presented = new Set(ix.teams.filter((t) => hasPresented(ix, t.id)).map((t) => t.id));
  const results = computeResults({
    teams: ix.teams.map((t) => ({ id: t.id, name: t.name, cards: t.cards, members: (ix.members.get(t.id) ?? []).map((p) => ({ name: p.name, certName: p.cert_name })) })),
    presented,
    ratings: ix.ratings,
    stickers: store.all("SELECT team_id, kind FROM stickers WHERE quest = 1 AND removed_at IS NULL"),
    judges: ix.judges.length,
  });
  return store.tx(() => {
    store.setMeta("results_json", { ...results, at: now });
    store.setMeta("results_step", 0);
    store.setMeta("phase", "results");
    store.setMeta("phase_at", now);
    store.audit("host", "resultsStart", { awards: results.awards.map((a) => [a.key, a.team?.name ?? null]) });
    return { ok: true, phaseChanged: true };
  });
}

export function reveal(ctx, { back }) {
  const { ix, store } = ctx;
  if (ix.phase !== "results") return { error: "THE RESULTS HAVEN'T STARTED." };
  const total = ix.meta.results_json.awards.length;
  const step = Math.max(0, Math.min(total, (ix.meta.results_step ?? 0) + (back === true ? -1 : 1)));
  return store.tx(() => {
    store.setMeta("results_step", step);
    store.audit("host", "reveal", { step });
    return { ok: true, step };
  });
}
