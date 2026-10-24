// Player name rules, shared by the server and the browser-only demo. Names show up on
// a shared screen at the fair, so they're short, plain and run through a small blocklist.
// The admin page catches the rest.

const NAME_PATTERN = /^[A-Za-z0-9 ._-]+$/;
export const NAME_MIN = 2;
export const NAME_MAX = 16;

// Blocked anywhere inside the name, even with separators removed ("f.u.c.k").
const BLOCKED_ANYWHERE = [
  "fuck", "shit", "bitch", "cunt", "nigg", "faggot", "slut", "whore", "porn",
  "pussy", "wank", "twat", "asshole", "bastard", "motherf", "retard", "dildo",
  "penis", "vagina", "nazi", "hitler", "boob",
  // Arabic and South Asian transliterations common on campus
  "sharmo", "sharmu", "kosom", "kusom", "manyak", "khawal", "chutiy", "bhench",
  "madarch", "behench",
];

// Blocked only as a whole word, because they hide inside normal names
// (Hancock, Essex, Cassie, Dickson, Gandhi).
const BLOCKED_WORDS = new Set([
  "ass", "dick", "cock", "sex", "fag", "tits", "cum", "anal", "rape", "kys", "milf",
  "hoe", "kos", "kus", "zeb", "zib", "ayre", "khara", "gand", "lund", "chod",
]);

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "@": "a", $: "s" };

function unleet(text) {
  return text.toLowerCase().replace(/[01345789@$]/g, (ch) => LEET[ch]);
}

export function isBlocked(name) {
  const plain = unleet(name);
  const squashed = plain.replace(/[^a-z]/g, "");
  if (BLOCKED_ANYWHERE.some((word) => squashed.includes(word))) return true;
  return plain.split(/[^a-z]+/).some((word) => BLOCKED_WORDS.has(word));
}

// Returns { name, key } on success or { error } with a message for the player.
export function normalizeName(raw) {
  if (typeof raw !== "string") return { error: "TYPE YOUR NAME TO START." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { error: "TYPE YOUR NAME TO START." };
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_PATTERN.test(name) || !/[A-Za-z0-9]/.test(name)) {
    return { error: `USE ${NAME_MIN} TO ${NAME_MAX} LETTERS OR NUMBERS.` };
  }
  if (isBlocked(name)) return { error: "PICK A DIFFERENT NAME." };
  return { name: name.toUpperCase(), key: name.toLowerCase() };
}
