// The feature cards: every team is dealt two features of a website to ruin. Pure: the draw pile
// is a plain array the caller stores, so a restarted server deals exactly the cards it would have.
import { CODE_LETTERS, CODE_LENGTH, nameKey } from "../../unfriendly/js/shared/rules.js";
import { isBlocked } from "../../public/js/shared/names.js";

// The "how to ruin it" lines are for the organisers and the examples shown at the deal.
export const FEATURES = [
  { id: "login", name: "Login", example: "The password is a Wordle you have to solve" },
  { id: "volume", name: "Volume control", example: "A volume control with boundaries" },
  { id: "qr", name: "QR code", example: "Draw the QR code yourself, then scan it" },
  { id: "unsubscribe", name: "Cancel or unsubscribe", example: "Every cancel asks again and opens another tab" },
  { id: "phone", name: "Phone number", example: "Pick your number on a slider from 0 to 9,999,999,999" },
  { id: "birthday", name: "Date of birth", example: "Scroll from the year 0001 to yours" },
  { id: "number", name: "Number input", example: "Type it in Roman numerals" },
  { id: "submit", name: "Submit button", example: "It moves away when you get close" },
  { id: "delete", name: "Delete account", example: "Two CANCEL buttons, and one of them deletes" },
  { id: "captcha", name: "CAPTCHA", example: "Select all squares with good UX" },
  { id: "loading", name: "Loading bar", example: "Stuck at 99% since Tuesday" },
  { id: "signup", name: "Sign-up", example: "Every username is already taken" },
  { id: "password", name: "Password rules", example: "A new rule appears each time you meet the last one" },
  { id: "cookies", name: "Cookie banner", example: "ACCEPT is huge; REJECT is nine menus deep" },
  { id: "search", name: "Search bar", example: "Only finds things you spell backwards" },
  { id: "checkout", name: "Checkout", example: "The quantity only goes up" },
  { id: "upload", name: "File upload", example: "Drag the file through a maze to the drop zone" },
  { id: "darkmode", name: "Dark mode switch", example: "The page goes dark and you hunt for the switch with a torch" },
  { id: "address", name: "Address form", example: "The country list reshuffles every time you scroll" },
  { id: "rating", name: "Star rating", example: "One star is picked for you; five stars runs away" },
  { id: "terms", name: "Terms and conditions", example: "Scroll to the end, with a scrollbar one pixel tall" },
  { id: "booking", name: "Booking a time", example: "One day at a time, starting in 1970" },
  { id: "support", name: "Support chat", example: "Answers every question with another question" },
  { id: "notifications", name: "Notifications", example: "Asks every five seconds: ALLOW or ALLOW" },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));
const ALL = FEATURES.map((f) => f.id);

export const feature = (id) => BY_ID.get(id) ?? null;
export const isFeature = (id) => BY_ID.has(id);

export function shuffled(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function newPile(random) {
  return shuffled(ALL, random);
}

// Takes the first card in the pile that isn't in `exclude` (changes the pile). When nothing's left
// that this team can have, a freshly shuffled deck goes behind it: only then do cards repeat.
export function drawCard(pile, exclude, random) {
  let i = pile.findIndex((id) => !exclude.has(id));
  let refilled = false;
  if (i === -1) {
    pile.push(...shuffled(ALL, random));
    refilled = true;
    i = pile.findIndex((id) => !exclude.has(id));
  }
  const [card] = pile.splice(i, 1);
  return { card, refilled };
}

// Two different cards for one team.
export function dealPair(pile, random) {
  const first = drawCard(pile, new Set(), random);
  const second = drawCard(pile, new Set([first.card]), random);
  return { cards: [first.card, second.card], refilled: first.refilled || second.refilled };
}

// Swaps the card in `slot`: the new one is neither of the team's cards, and the old one goes to
// the bottom of the pile afterwards, so it can't come straight back.
export function swapCard(pile, held, slot, random) {
  const old = held[slot];
  const { card, refilled } = drawCard(pile, new Set(held), random);
  pile.push(old);
  const cards = [...held];
  cards[slot] = card;
  return { cards, old, card, refilled };
}

export function newCode(taken, random = Math.random) {
  for (let tries = 0; tries < 1000; tries += 1) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
    if (!taken.has(code) && !isBlocked(code)) return code;
  }
  throw new Error("Ran out of team codes");
}

// Names for teams the host makes out of people who tapped FIND ME A TEAM.
export const POOL_TEAM_NAMES = [
  "Team 404", "Team Captcha", "Team Loading", "Team Error 002", "Team Accept All", "Team Undefined",
  "Team Pop-up", "Team Spinner", "Team Null", "Team Refresh", "Team Deprecated", "Team Timeout",
  "Team Try Again", "Team Are You Sure", "Team Buffering", "Team Blue Link", "Team Dark Pattern",
  "Team Dead Click", "Team Infinite Scroll", "Team Read More",
];

/*
  Puts the people waiting for a team into teams. New teams (of about three) are made while
  there's room under the host's number of teams; then everyone goes, one at a time, to the
  smallest team with room, preferring new teams on a tie so they don't stay tiny. Nobody joins a
  team that already has someone with their name. Pure: returns what to do, the caller does it.

  pool:  [{ id, nameKey }] in the order they asked
  teams: [{ id, size, nameKeys: [] }] the teams there are now
  returns { newTeams: [{ name, members: [personId] }], joins: [{ personId, teamId }], over: [teamId], stuck: [personId] }
*/
export function groupPool(pool, teams, { maxTeams, maxSize, takenNames = new Set() }) {
  const live = teams.map((t) => ({ id: t.id, size: t.size, keys: new Set(t.nameKeys), isNew: false }));
  const result = { newTeams: [], joins: [], over: [], stuck: [] };
  const free = Math.max(0, maxTeams - teams.length);
  let count = Math.min(free, Math.floor(pool.length / 3));
  // Nobody has a team yet and too few are waiting for a team of three: they become one team.
  if (count === 0 && live.length === 0 && free > 0 && pool.length > 0) count = 1;

  // In list order, not random, so the host's preview and the real thing are the same.
  const names = POOL_TEAM_NAMES.filter((n) => !takenNames.has(nameKey(n)));
  for (let i = 0; i < count; i += 1) {
    const name = names[i] ?? `Team ${teams.length + i + 1}`;
    const team = { id: null, name, size: 0, keys: new Set(), isNew: true, members: [] };
    live.push(team);
    result.newTeams.push(team);
  }

  const smallest = (list) => list.sort((a, b) => a.size - b.size || Number(b.isNew) - Number(a.isNew))[0];
  for (const person of pool) {
    const fits = live.filter((t) => !t.keys.has(person.nameKey));
    const target = smallest(fits.filter((t) => t.size < maxSize)) ?? smallest(fits);
    if (!target) {
      result.stuck.push(person.id);
      continue;
    }
    target.size += 1;
    target.keys.add(person.nameKey);
    if (target.size > maxSize && !target.isNew && !result.over.includes(target.id)) result.over.push(target.id);
    if (target.isNew) target.members.push(person.id);
    else result.joins.push({ personId: person.id, teamId: target.id });
  }
  result.newTeams = result.newTeams.filter((t) => t.members.length > 0).map((t) => ({ name: t.name, members: t.members }));
  return result;
}
