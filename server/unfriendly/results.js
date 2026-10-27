// Who wins. The judges' ratings decide the main award (USER UNFRIENDLIEST); everyone's side-quest
// stickers decide the four side quests. One title per team, the main award first. Every number is
// kept, so any result can be explained afterwards.
import { QUESTS } from "../../unfriendly/js/shared/rules.js";
import { feature } from "./deck.js";

export const MAIN_AWARD = "User unfriendliest";
const SHRINK = 2; // how strongly a judge with few ratings is pulled towards everyone's average

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs, m = mean(xs)) => mean(xs.map((x) => (x - m) ** 2));

/*
  Each judge's ratings are compared with that judge's own (a harsh judge and a generous one count
  the same), shrunk towards the whole room's for judges with few ratings. Each team's highest and
  lowest 10% are then dropped and the rest averaged.
*/
export function judgeScores(ratings, minRatings) {
  if (ratings.length === 0) return new Map();
  const values = ratings.map((r) => r.value);
  const mu = mean(values);
  const sigma2 = variance(values, mu);
  const byJudge = new Map();
  for (const r of ratings) byJudge.set(r.judge_id, [...(byJudge.get(r.judge_id) ?? []), r.value]);
  const norm = new Map();
  for (const [judge, vs] of byJudge) {
    const n = vs.length;
    const m = (n * mean(vs) + SHRINK * mu) / (n + SHRINK);
    const s = Math.max(0.5, Math.sqrt((n * variance(vs) + SHRINK * sigma2) / (n + SHRINK)));
    norm.set(judge, { m, s });
  }
  const byTeam = new Map();
  for (const r of ratings) {
    const { m, s } = norm.get(r.judge_id);
    const entry = byTeam.get(r.team_id) ?? { z: [], raw: [] };
    entry.z.push((r.value - m) / s);
    entry.raw.push(r.value);
    byTeam.set(r.team_id, entry);
  }
  const scores = new Map();
  for (const [teamId, { z, raw }] of byTeam) {
    const sorted = [...z].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * 0.1);
    const kept = sorted.slice(cut, sorted.length - cut);
    scores.set(teamId, { score: mean(kept), ratings: raw.length, rawMean: mean(raw), eligible: raw.length >= minRatings });
  }
  return scores;
}

// teams: [{ id, name, members: [{ name, certName }], cards }], presented: Set of team ids,
// ratings: rows of the ratings table, stickers: [{ team_id, kind }] (side-quest stickers only).
export function computeResults({ teams, presented, ratings, stickers, judges }) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const minRatings = Math.max(1, Math.min(5, judges));
  const scores = judgeScores(ratings.filter((r) => presented.has(r.team_id)), minRatings);
  const scoreOf = (id) => scores.get(id)?.score ?? -Infinity;
  const ranked = [...scores.entries()]
    .filter(([id, s]) => s.eligible && presented.has(id))
    .sort(([a, x], [b, y]) => y.score - x.score || y.ratings - x.ratings || y.rawMean - x.rawMean || a - b);

  const taken = new Set();
  const award = (key, title, teamId, detail) => ({ key, title, team: teamId === null ? null : { id: teamId, name: byId.get(teamId).name, members: byId.get(teamId).members, cards: byId.get(teamId).cards }, detail });
  const main = ranked[0] ? ranked[0][0] : null;
  if (main !== null) taken.add(main);

  // Side quests: the biggest share of a quest's stickers takes it first, one title per team where possible.
  const counts = new Map(); // `${team}|${kind}` → n
  const totals = new Map();
  for (const s of stickers) {
    if (!presented.has(s.team_id)) continue;
    counts.set(`${s.team_id}|${s.kind}`, (counts.get(`${s.team_id}|${s.kind}`) ?? 0) + 1);
    totals.set(s.kind, (totals.get(s.kind) ?? 0) + 1);
  }
  const candidates = [];
  for (const [key, n] of counts) {
    const [team, kind] = key.split("|");
    candidates.push({ teamId: Number(team), kind, n, share: n / totals.get(kind) });
  }
  // Ties: more stickers, then the judges' score; a team tied with itself across quests takes the
  // one listed first (Best UI, Funniest, Creative, Best worst feature).
  const questOrder = (kind) => QUESTS.findIndex((q) => q.kind === kind);
  candidates.sort((a, b) => b.share - a.share || b.n - a.n || scoreOf(b.teamId) - scoreOf(a.teamId) || a.teamId - b.teamId || questOrder(a.kind) - questOrder(b.kind));
  const questWinner = new Map();
  for (const c of candidates) {
    if (questWinner.has(c.kind) || taken.has(c.teamId)) continue;
    questWinner.set(c.kind, c);
    taken.add(c.teamId);
  }
  // A quest that would go to nobody (every team with its stickers already has a title) goes to
  // the best of those teams after all, rather than being left empty.
  for (const c of candidates) {
    if (!questWinner.has(c.kind)) questWinner.set(c.kind, { ...c, repeat: true });
  }

  const awards = QUESTS.map((q) => {
    const w = questWinner.get(q.kind);
    return award(q.kind, q.name, w ? w.teamId : null, w ? { stickers: w.n, of: totals.get(q.kind), share: w.share, ...(w.repeat ? { repeat: true } : {}) } : { stickers: 0 });
  });
  awards.push(award("main", MAIN_AWARD, main, main === null ? null : { ...scores.get(main) }));

  return {
    awards,
    numbers: {
      judges: Object.fromEntries([...scores].map(([id, s]) => [byId.get(id)?.name ?? id, s])),
      stickers: Object.fromEntries([...counts].map(([k, n]) => [`${byId.get(Number(k.split("|")[0]))?.name}|${k.split("|")[1]}`, n])),
      minRatings,
    },
  };
}

// ---------- CSV (opens in Excel and Sheets with accents intact, and can't run a formula) ----------
function cell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const csv = (rows) => `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;

export function winnersCsv(results) {
  const rows = [["Award", "Team", "Name on certificate"]];
  for (const a of results.awards) {
    if (!a.team) continue;
    for (const m of a.team.members) rows.push([a.title, a.team.name, m.certName ?? m.name]);
  }
  return csv(rows);
}

export function participantsCsv(ix, presented) {
  const rows = [["Name on certificate", "Name", "Team", "Feature", "Presented"]];
  for (const t of ix.teams) {
    for (const p of ix.members.get(t.id) ?? []) {
      const features = t.cards.map((id) => feature(id)?.name ?? id).join(" + ");
      rows.push([p.cert_name ?? p.name, p.name, t.name, features, presented.has(t.id) ? "yes" : "no"]);
    }
  }
  return csv(rows);
}

export function judgesCsv(ix) {
  const rows = [["Judge", "Team", "Rating"]];
  for (const r of ix.ratings) rows.push([ix.personById.get(r.judge_id)?.name ?? r.judge_id, ix.teamById.get(r.team_id)?.name ?? r.team_id, r.value]);
  return csv(rows);
}
