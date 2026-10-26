// USER UNFRIENDLY: the rules both the server and the phones check. A phone uses them to say
// what's wrong before it asks; the server checks everything again and never trusts a phone.
import { isBlocked } from "../../../public/js/shared/names.js";

export const PERSON_MIN = 2;
export const PERSON_MAX = 40;
export const TEAM_MIN = 2;
export const TEAM_MAX = 24;
// No letters that look alike (O/0, I/1, B/8, S/5, G/6, L, Q, Z) and no vowels that spell words.
export const CODE_LETTERS = "ACDEFHJKMNPRTUVWXY";
export const CODE_LENGTH = 4;

// The host sets these on the day: about 60 people means 15 teams, about 40 means 10.
export const DEFAULT_MAX_TEAMS = 15;
export const DEFAULT_MAX_SIZE = 4;
export const MAX_TEAMS_LIMIT = 40;
export const MAX_SIZE_LIMIT = 8;
export const MIN_SIZE_LIMIT = 2;

export const SWAP_MS = 5 * 60_000;
export const BUILD_MS = 55 * 60_000;

// Names go on certificates, so they're kept as typed: accents, apostrophes and hyphens are fine.
const PERSON_PATTERN = /^[\p{L}\p{M}0-9 .'’-]+$/u;
const TEAM_PATTERN = /^[\p{L}\p{M}0-9 .'’!?&#-]+$/u;
// Blocked anywhere inside a person's name. This is the "anywhere" half of the arcade's list in
// public/js/shared/names.js; its whole-word half isn't used for people, because it would refuse
// real names. Team names get the full check.
const BLOCKED_IN_NAMES = [
  "fuck", "shit", "bitch", "cunt", "nigg", "faggot", "slut", "whore", "porn",
  "pussy", "wank", "twat", "asshole", "bastard", "motherf", "retard", "dildo",
  "penis", "vagina", "nazi", "hitler", "boob",
  "sharmo", "sharmu", "kosom", "kusom", "manyak", "khawal", "chutiy", "bhench",
  "madarch", "behench",
];

const length = (text) => [...text].length;

// How a name is compared: accents, case and punctuation don't count ("Zoë O'Brien" = "zoe o brien").
export function nameKey(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tidy(raw) {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

// { name, key } or { error } with a message for the phone.
export function personName(raw) {
  if (typeof raw !== "string") return { error: "TYPE YOUR NAME." };
  const name = tidy(raw);
  if (!name) return { error: "TYPE YOUR NAME." };
  if (length(name) < PERSON_MIN || length(name) > PERSON_MAX || !PERSON_PATTERN.test(name) || !/\p{L}/u.test(name)) {
    return { error: `USE ${PERSON_MIN} TO ${PERSON_MAX} LETTERS.` };
  }
  const squashed = nameKey(name).replace(/ /g, "");
  if (BLOCKED_IN_NAMES.some((word) => squashed.includes(word))) return { error: "TYPE YOUR REAL NAME." };
  return { name, key: nameKey(name) };
}

export function teamName(raw) {
  if (typeof raw !== "string") return { error: "NAME YOUR TEAM." };
  const name = tidy(raw);
  if (!name) return { error: "NAME YOUR TEAM." };
  if (length(name) < TEAM_MIN || length(name) > TEAM_MAX || !TEAM_PATTERN.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    return { error: `USE ${TEAM_MIN} TO ${TEAM_MAX} LETTERS OR NUMBERS.` };
  }
  if (isBlocked(nameKey(name))) return { error: "PICK A DIFFERENT TEAM NAME." };
  return { name, key: nameKey(name) };
}

// A team code as typed ("kxa-m", " KXAM ") → "KXAM", or null if it can't be one.
export function teamCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => CODE_LETTERS.includes(ch)) ? code : null;
}

// ---------- Links to the teams' sites ----------
export const URL_MAX = 400;
// http(s) only, on the internet: nothing on this laptop or the local network (a team's "site"
// opens on the host's laptop), and no user name or password in it.
export function siteUrl(raw) {
  if (typeof raw !== "string") return { error: "PASTE YOUR SITE'S LINK." };
  let text = raw.trim();
  if (!text) return { error: "PASTE YOUR SITE'S LINK." };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  if (text.length > URL_MAX) return { error: "THAT LINK IS TOO LONG. USE A SHORTER SHARE LINK." };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: "THAT DOESN'T LOOK LIKE A LINK." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "USE AN HTTP OR HTTPS LINK." };
  if (url.username || url.password) return { error: "TAKE THE NAME AND PASSWORD OUT OF THE LINK." };
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith("[");
  if (local) return { error: "THAT LINK ONLY WORKS ON YOUR LAPTOP. SHARE A PUBLIC LINK." };
  return { url: url.href.slice(0, URL_MAX), host };
}

// ---------- Judges ----------
export const RATINGS = ["Super poop", "Poop", "OK", "Good", "Epic", "Legendary"];
export const PIN_PATTERN = /^\d{4,8}$/;

// ---------- Stickers ----------
// Side quests: one of each per person for the whole show, so nobody can stack a title; they decide the side-quest titles.
export const QUESTS = [
  { kind: "best-ui", name: "Best UI" },
  { kind: "funniest", name: "Funniest bad UX" },
  { kind: "creative", name: "Most creative UX" },
  { kind: "worst-feature", name: "Best worst feature" },
];
// How many features each team is dealt to ruin (one swap per team either way).
export const CARDS_PER_TEAM = 1;
export const QUEST_EACH = 1;
// Just for fun: they don't count, at most a few per person per team.
export const JOKES = [
  { kind: "send-help", name: "Send help" },
  { kind: "ten", name: "10/10 UI" },
  { kind: "why", name: "Why" },
  { kind: "cancel-ok", name: "Cancel (means OK)" },
  { kind: "rage", name: "Rage click" },
];
export const JOKES_PER_TEAM = 5;
export const stickerKind = (kind) => QUESTS.find((q) => q.kind === kind) ?? JOKES.find((j) => j.kind === kind) ?? null;
export const isQuest = (kind) => QUESTS.some((q) => q.kind === kind);
