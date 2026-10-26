// The event's rules and what each screen is shown. Pure: everything takes the state read from
// the database and `now`, so a deadline that passed while the server was stopped is simply past.
// Nothing here changes the phase on a timer: the host moves the event on.
import { DEFAULT_MAX_SIZE, DEFAULT_MAX_TEAMS, QUESTS, QUEST_EACH, RATINGS } from "../../unfriendly/js/shared/rules.js";
import { feature } from "./deck.js";

export const PHASES = ["join", "deal", "build", "present", "results"];
// Teams and their members can only change by phone while teams are being made and dealt.
const OPEN_PHASES = new Set(["join", "deal"]);
// A judge who was offline when the host pressed NEXT can still give that team a first rating.
export const LATE_RATING_MS = 15_000;

// Lookups over the state from store.load(), built once per change.
export function index(core) {
  const meta = core.meta;
  const teams = core.teams.filter((t) => t.removed_at === null);
  const people = core.people.filter((p) => p.removed_at === null);
  const members = new Map(teams.map((t) => [t.id, []]));
  for (const p of people) if (p.role === "participant" && p.team_id !== null && members.has(p.team_id)) members.get(p.team_id).push(p);
  const demos = (core.demos ?? []).filter((d) => teams.some((t) => t.id === d.team_id));
  const ratings = core.ratings ?? [];
  return {
    meta,
    phase: meta.phase ?? "join",
    maxTeams: meta.max_teams ?? DEFAULT_MAX_TEAMS,
    maxSize: meta.max_size ?? DEFAULT_MAX_SIZE,
    teams,
    allTeams: core.teams,
    teamById: new Map(teams.map((t) => [t.id, t])),
    people,
    personById: new Map(people.map((p) => [p.id, p])),
    members,
    pool: people.filter((p) => p.role === "participant" && p.team_id === null && p.pool_since !== null).sort((a, b) => a.pool_since - b.pool_since || a.id - b.id),
    judges: people.filter((p) => p.role === "judge"),
    demos,
    currentSlot: meta.current_slot ?? 0,
    ratings,
  };
}

// ---------- Rules ----------
export const isOpen = (ix) => OPEN_PHASES.has(ix.phase);
export const canMake = (ix) => isOpen(ix) && ix.teams.length < ix.maxTeams;
// Teams lock at the build; a team the host added late takes joins by code until the results.
export const acceptsJoins = (ix, team) => isOpen(ix) || (team.origin === "host" && ix.phase !== "results");
export const hasRoom = (ix, team) => (ix.members.get(team.id)?.length ?? 0) < ix.maxSize;
export const canLeave = (ix) => ix.phase === "join";
export const canRename = (ix) => isOpen(ix);
// Swapping is for the deal and the build only: never once presenting has started.
export const canSwap = (ix, team, now) => (ix.phase === "deal" || ix.phase === "build") && team.dealt_at !== null && team.swapped_at === null && team.swap_until !== null && now < team.swap_until;

export function makeError(ix) {
  if (!isOpen(ix)) return "TEAMS ARE LOCKED. ASK AN ORGANISER.";
  if (ix.teams.length >= ix.maxTeams) return `ALL ${ix.maxTeams} TEAMS ARE MADE. JOIN ONE, OR TAP FIND ME A TEAM.`;
  return null;
}

// Links go in from when the host opens them until pencils down (or later, if the host extends it).
export function linksWindow(ix, now) {
  const openAt = ix.meta.links_open_at ?? null;
  const closeAt = ix.meta.links_close_at ?? ix.meta.build_end_at ?? null;
  const open = openAt !== null && closeAt !== null && now < closeAt && (ix.phase === "build" || ix.phase === "present");
  return { open, openAt, closeAt };
}

// The running order and where the show is.
export function showState(ix, now) {
  const slots = ix.demos.map((d) => {
    const state = d.slot < ix.currentSlot ? "done" : d.slot > ix.currentSlot ? "waiting" : d.started_at === null ? "intro" : now < d.ends_at ? "running" : "overtime";
    return { ...d, state };
  });
  return { slots, current: slots.find((s) => s.slot === ix.currentSlot) ?? null, finished: ix.demos.length > 0 && ix.currentSlot >= ix.demos.length };
}

// A team has presented (or is presenting) once its demo has started.
export function hasPresented(ix, teamId) {
  const demo = ix.demos.find((d) => d.team_id === teamId);
  if (!demo) return false;
  return demo.slot < ix.currentSlot || (demo.slot === ix.currentSlot && demo.started_at !== null);
}

export const stickersOpen = (ix) => ix.phase === "present";

// Which team a judge may rate now, and whether it counts as late.
export function rateable(ix, judgeId, teamId, now) {
  if (ix.phase !== "present") return null;
  const demo = ix.demos.find((d) => d.team_id === teamId);
  if (!demo) return null;
  if (demo.slot === ix.currentSlot && demo.started_at !== null) return { late: false };
  const rated = ix.ratings.some((r) => r.judge_id === judgeId && r.team_id === teamId);
  if (demo.slot === ix.currentSlot - 1 && demo.ended_at !== null && now - demo.ended_at <= LATE_RATING_MS && !rated) return { late: true };
  return null;
}

// How long each demo gets: the presenting time shared out, less 20 s to change over, in 5 s steps.
export function demoLength(budgetMs, teams, scale = 1) {
  if (teams <= 0) return Math.round(120_000 * scale);
  const raw = budgetMs / teams - 20_000 * scale;
  const step = 5_000 * scale;
  return Math.max(Math.round(45_000 * scale), Math.min(Math.round(120_000 * scale), Math.floor(raw / step) * step));
}

const cardsOf = (team) => (team.dealt_at === null ? [] : team.cards.map((id) => ({ id, name: feature(id)?.name ?? id })));
const cardNames = (team) => cardsOf(team).map((c) => c.name);

function buildInfo(ix) {
  if (ix.meta.build_end_at === undefined) return null;
  return { startAt: ix.meta.build_start_at, endAt: ix.meta.build_end_at };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// What every phone sees of the show: the running order and who's up.
function showForPhones(ix, now, ownTeamId) {
  if (ix.phase !== "present") return null;
  const { slots, current, finished } = showState(ix, now);
  const team = current ? ix.teamById.get(current.team_id) : null;
  const yours = ownTeamId ? slots.find((s) => s.team_id === ownTeamId) : null;
  return {
    finished,
    total: slots.length,
    current: team ? { slot: current.slot, teamId: team.id, name: team.name, cards: cardNames(team), state: current.state, endsAt: current.ends_at } : null,
    yourSlot: yours ? yours.slot : null,
    upIn: yours && !finished ? yours.slot - ix.currentSlot : null,
  };
}

// The sticker side of a phone: the teams it can sticker and what's left on its sheet.
// `used` = { kind: count } of this person's stuck side-quest stickers.
function stickersFor(ix, ownTeamId, used) {
  if (!stickersOpen(ix)) return null;
  const teams = ix.demos
    .filter((d) => hasPresented(ix, d.team_id) && d.team_id !== ownTeamId)
    .sort((a, b) => b.slot - a.slot)
    .map((d) => {
      const t = ix.teamById.get(d.team_id);
      return { id: t.id, name: t.name, cards: cardNames(t) };
    });
  return { teams, left: Object.fromEntries(QUESTS.map((q) => [q.kind, Math.max(0, QUEST_EACH - (used?.[q.kind] ?? 0))])) };
}

// The results as revealed so far (frozen at the start of the results).
function revealed(ix) {
  if (ix.phase !== "results" || !ix.meta.results_json) return null;
  const step = ix.meta.results_step ?? 0;
  const awards = ix.meta.results_json.awards;
  return { step: Math.min(step, awards.length), total: awards.length, awards: awards.slice(0, step), ended: step > awards.length };
}

// ---------- Views ----------
// What a phone that isn't anyone yet may do.
export function whoView(ix, now) {
  return {
    phase: ix.phase,
    serverNow: now,
    open: isOpen(ix),
    canMake: canMake(ix),
    teamsLeft: Math.max(0, ix.maxTeams - ix.teams.length),
    maxSize: ix.maxSize,
    links: linksWindow(ix, now).open,
    stickers: stickersOpen(ix),
    teams: stickersOpen(ix) ? ix.teams.map((t) => ({ id: t.id, name: t.name })) : [],
    results: ix.phase === "results" ? revealed(ix) : null,
  };
}

export function participantView(ix, person, now, online = new Set(), used = {}) {
  const team = person.team_id === null ? null : ix.teamById.get(person.team_id) ?? null;
  const links = linksWindow(ix, now);
  const view = {
    phase: ix.phase,
    serverNow: now,
    you: { id: person.id, name: person.name, role: person.role },
    waiting: team === null && person.pool_since !== null,
    canMake: canMake(ix),
    canLeave: team !== null && canLeave(ix),
    canRename: team !== null && canRename(ix),
    teamsLeft: Math.max(0, ix.maxTeams - ix.teams.length),
    maxSize: ix.maxSize,
    build: buildInfo(ix),
    links: { open: links.open, closeAt: links.closeAt },
    show: showForPhones(ix, now, team?.id ?? null),
    stickers: stickersFor(ix, team?.id ?? null, used),
    results: revealed(ix),
    team: null,
  };
  if (team) {
    view.team = {
      id: team.id,
      name: team.name,
      code: team.code,
      members: (ix.members.get(team.id) ?? []).map((p) => ({ id: p.id, name: p.name, online: online.has(p.id), you: p.id === person.id })),
      cards: cardsOf(team),
      swapUntil: team.swap_until,
      swapped: team.swapped_at !== null,
      canSwap: canSwap(ix, team, now),
      link: team.link_kind === "own-laptop" ? { ownLaptop: true } : team.link_url ? { url: team.link_url, host: hostOf(team.link_url) } : null,
    };
  }
  return view;
}

// Someone who scanned the sticker QR and isn't in a team (or says which team they're in).
export function audienceView(ix, person, now, used = {}) {
  const own = person.own_team_id ?? null;
  return {
    phase: ix.phase,
    serverNow: now,
    you: { id: person.id, name: person.name, role: "audience", ownTeam: own === null ? null : ix.teamById.get(own)?.name ?? null },
    show: showForPhones(ix, now, own),
    stickers: stickersFor(ix, own, used),
    results: revealed(ix),
  };
}

export function judgeView(ix, judge, now) {
  const mine = new Map(ix.ratings.filter((r) => r.judge_id === judge.id).map((r) => [r.team_id, r.value]));
  const { current, finished, slots } = showState(ix, now);
  const describe = (slot) => {
    if (!slot) return null;
    const team = ix.teamById.get(slot.team_id);
    const demo = ix.demos.find((d) => d.team_id === team.id);
    return {
      teamId: team.id,
      slot: slot.slot,
      name: team.name,
      cards: cardNames(team),
      members: (ix.members.get(team.id) ?? []).map((p) => p.name),
      state: slot.state,
      endsAt: slot.ends_at,
      rating: mine.get(team.id) ?? null,
      canRate: rateable(ix, judge.id, team.id, now) !== null,
      closesAt: demo?.ended_at != null ? demo.ended_at + LATE_RATING_MS : null,
    };
  };
  const previous = slots.find((s) => s.slot === ix.currentSlot - 1);
  return {
    phase: ix.phase,
    serverNow: now,
    you: { id: judge.id, name: judge.name, role: "judge" },
    ratings: RATINGS,
    current: describe(current),
    previous: previous && rateable(ix, judge.id, previous.team_id, now) ? describe(previous) : null,
    finished,
    total: slots.length,
    rated: mine.size,
  };
}

// The big screen: never a team code (anyone could join a team by reading it off the wall), never
// a judge's rating or anyone's stickers.
export function screenView(ix, now, online = new Set()) {
  const links = linksWindow(ix, now);
  const show = ix.phase === "present" ? showState(ix, now) : null;
  const teamOf = (id) => ix.teamById.get(id);
  return {
    phase: ix.phase,
    serverNow: now,
    maxTeams: ix.maxTeams,
    maxSize: ix.maxSize,
    counts: {
      people: ix.people.filter((p) => p.role === "participant").length,
      teams: ix.teams.length,
      waiting: ix.pool.length,
      online: ix.people.filter((p) => online.has(p.id)).length,
    },
    teams: ix.teams.map((t) => {
      const members = ix.members.get(t.id) ?? [];
      return {
        id: t.id,
        name: t.name,
        members: members.map((p) => p.name),
        online: members.filter((p) => online.has(p.id)).length,
        cards: cardNames(t),
        dealt: t.dealt_at !== null,
        swapped: t.swapped_at !== null,
        linked: Boolean(t.link_url) || t.link_kind === "own-laptop",
      };
    }),
    dealAt: ix.meta.deal_at ?? null,
    build: buildInfo(ix),
    links: { open: links.open, closeAt: links.closeAt },
    show: show && {
      finished: show.finished,
      total: show.slots.length,
      demoMs: ix.meta.demo_ms ?? null,
      current: show.current && {
        slot: show.current.slot,
        state: show.current.state,
        endsAt: show.current.ends_at,
        name: teamOf(show.current.team_id).name,
        members: (ix.members.get(show.current.team_id) ?? []).map((p) => p.name),
        cards: cardNames(teamOf(show.current.team_id)),
      },
      next: show.slots
        .filter((s) => s.slot > ix.currentSlot)
        .slice(0, 3)
        .map((s) => teamOf(s.team_id).name),
    },
    results: revealed(ix),
  };
}

// The host panel on the laptop screen: everything, including codes, links and counts.
// extra = { ratingCounts: Map teamId→n, stickerCounts: Map teamId→n, judgesOnline }
export function hostView(ix, now, online = new Set(), extra = {}) {
  const screen = screenView(ix, now, online);
  const show = ix.phase === "present" ? showState(ix, now) : null;
  return {
    ...screen,
    teams: ix.teams.map((t, i) => ({
      ...screen.teams[i],
      code: t.code,
      origin: t.origin,
      people: (ix.members.get(t.id) ?? []).map((p) => ({ id: p.id, name: p.name, certName: p.cert_name, online: online.has(p.id) })),
      cardIds: t.dealt_at === null ? [] : t.cards,
      replaced: t.replaced?.filter(Boolean).map((id) => feature(id)?.name ?? id) ?? [],
      swapUntil: t.swap_until,
      canSwap: canSwap(ix, t, now),
      over: (ix.members.get(t.id)?.length ?? 0) > ix.maxSize,
      link: t.link_kind === "own-laptop" ? { ownLaptop: true } : t.link_url ? { url: t.link_url, host: hostOf(t.link_url) } : null,
      ratings: extra.ratingCounts?.get(t.id) ?? 0,
      stickers: extra.stickerCounts?.get(t.id) ?? 0,
    })),
    pool: ix.pool.map((p) => ({ id: p.id, name: p.name, since: p.pool_since, online: online.has(p.id) })),
    loose: ix.people
      .filter((p) => p.role === "participant" && p.team_id === null && p.pool_since === null)
      .map((p) => ({ id: p.id, name: p.name, online: online.has(p.id) })),
    judges: ix.judges.map((j) => ({ id: j.id, name: j.name, online: online.has(j.id) })),
    audience: ix.people.filter((p) => p.role === "audience").length,
    order: show ? show.slots.map((s) => ({ slot: s.slot, teamId: s.team_id, name: ix.teamById.get(s.team_id).name, state: s.state, endsAt: s.ends_at, startedAt: s.started_at })) : [],
    presentAt: ix.meta.present_at ?? null,
    budgetMs: ix.meta.present_budget_ms ?? null,
    canUndoDeal: ix.phase === "deal" && now - (ix.meta.deal_at ?? 0) <= 2 * 60_000 && !ix.teams.some((t) => t.swapped_at !== null),
    resultsAll: ix.phase === "results" ? ix.meta.results_json ?? null : null,
    eventId: ix.meta.event_id,
    judgePin: ix.meta.judge_pin,
  };
}
