// A participant's phone: make a team, join one with its code, or ask to be put in one; see the two
// features your team has to ruin, swap one, and keep them on screen through the build. If the
// link changes (the server restarted), you get back in with your team code and your name.
import { connect, storeKey, readStore, writeStore } from "./net.js";
import { $, h, replaceKeeping, ask, toast, clock, timeOfDay, logo } from "./ui.js";
import { personName, teamName, teamCode, siteUrl } from "./shared/rules.js";
import { createStickers } from "./stickers.js";
import { dither } from "../brand/user-unfriendly.js";

const KEY = storeKey("phone");
// Offline this long outside the build: the link has probably changed.
const LOST_MS = 30_000;

const ui = {
  status: "connecting",
  offlineSince: 0,
  who: null, // what a phone that isn't anyone yet may do
  view: null, // who you are, your team, your cards
  mode: "start", // start | make | join | pool | back | back-name | rename
  found: null, // the people to pick from when getting back in
  foundBy: null, // { code } or { name }
  error: "",
  busy: false,
  everOnline: false,
  cardsShown: "", // the cards whose flip has already played
};
let lastShown = "";

const net = connect({ key: KEY, onMessage, onStatus });
const stickers = createStickers(net);
dither($("edge"), { cols: 120, rows: 8, color: "#0D0D0D" });

function onStatus(status) {
  ui.status = status;
  if (status === "online") {
    ui.offlineSince = 0;
    ui.everOnline = true;
  }
  else if (!ui.offlineSince) ui.offlineSince = Date.now();
  render();
}

function onMessage(msg) {
  if (msg.t === "pile" || msg.t === "pile+") return stickers.onMessage(msg);
  if (msg.t === "who") {
    ui.who = msg.view;
    ui.view = null;
  } else if (msg.t === "view") {
    ui.view = msg.view;
    ui.who = null;
    // Kept on the phone, so the features stay on screen while the server is stopped.
    if (msg.view.team) writeStore(KEY, { cache: { team: msg.view.team, build: msg.view.build, phase: msg.view.phase, you: msg.view.you, offset: net.serverNow() - Date.now() } });
  } else if (msg.t === "removed") {
    writeStore(KEY, { cache: null });
  } else if (msg.t === "error") {
    toast(msg.message);
  }
  render();
}

// ---------- Actions ----------
async function run(msg) {
  ui.busy = true;
  ui.error = "";
  render();
  const reply = await net.act(msg);
  ui.busy = false;
  if (reply.t === "no") ui.error = reply.error;
  // Made, joined, waiting or back in: the form's done.
  if (reply.t === "ok" && ["make", "join", "pool", "claim", "audience"].includes(msg.t)) ui.mode = "start";
  render();
  return reply;
}

function value(id) {
  return $(id)?.value ?? "";
}

function rememberName(name) {
  writeStore(KEY, { name });
}

async function submitMake(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  const team = teamName(value("f-team"));
  ui.error = name.error ?? team.error ?? "";
  if (ui.error) return render();
  rememberName(name.name);
  await run({ t: "make", name: name.name, team: team.name });
}

async function submitJoin(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  const code = teamCode(value("f-code"));
  ui.error = name.error ?? (code ? "" : "A TEAM CODE IS 4 LETTERS. ASK YOUR TEAM.");
  if (ui.error) return render();
  rememberName(name.name);
  await run({ t: "join", name: name.name, code });
}

async function submitPool(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  ui.error = name.error ?? "";
  if (ui.error) return render();
  rememberName(name.name);
  await run({ t: "pool", name: name.name });
}

async function submitLookup(event) {
  event.preventDefault();
  const code = teamCode(value("f-code"));
  if (!code) {
    ui.error = "A TEAM CODE IS 4 LETTERS. ASK YOUR TEAM.";
    return render();
  }
  const reply = await run({ t: "lookup", code });
  if (reply.t === "found") {
    ui.found = reply.team.members.map((m) => ({ id: m.id, name: m.name, team: reply.team.name }));
    ui.foundBy = { code };
    // A team the host added late: someone not on its list can join it here with their name.
    ui.lateTeam = reply.team.canJoin ? { code, name: reply.team.name } : null;
    ui.joiningLate = ui.found.length === 0 && Boolean(ui.lateTeam);
    render();
  }
}

async function submitFind(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  ui.error = name.error ?? "";
  if (ui.error) return render();
  const reply = await run({ t: "find", name: name.name });
  if (reply.t === "found") {
    ui.found = reply.found;
    ui.foundBy = { name: name.name };
    render();
  }
}

async function claim(person) {
  let reply = await run({ t: "claim", personId: person.id, ...ui.foundBy });
  if (reply.t === "no" && reply.elsewhere) {
    ui.error = "";
    const yes = await ask(`${person.name} is open on another phone`, "Move them to this phone? The other phone will stop.", { yes: "Move here", no: "Cancel" });
    if (yes) reply = await run({ t: "claim", personId: person.id, ...ui.foundBy, force: true });
  }
  if (reply.t === "ok") {
    ui.found = null;
    rememberName(person.name);
  }
}

async function swap(card, slot) {
  const yes = await ask(`Swap ${card.name}?`, "Your team gets one swap. The new card is random.", { yes: "Swap it", no: "Keep it", bar: "SWAP.EXE" });
  if (yes) await run({ t: "swap", slot });
}

async function leave() {
  const yes = await ask("Leave this team?", "You can make or join another team after.", { yes: "Leave", no: "Stay" });
  if (yes) {
    ui.mode = "start";
    await run({ t: "leave" });
  }
}

async function submitLink(event) {
  event.preventDefault();
  const url = siteUrl(value("f-url"));
  const needsCode = !ui.view?.team;
  const code = needsCode ? teamCode(value("f-code")) : undefined;
  ui.error = url.error ?? (needsCode && !code ? "A TEAM CODE IS 4 LETTERS. ASK YOUR TEAM." : "");
  if (ui.error) return render();
  const reply = await run({ t: "link", url: url.url, ...(needsCode ? { code } : {}) });
  if (reply.t === "ok") toast(`Sent: ${reply.team ?? "your team"}'s link is in.`);
}

async function submitAudience(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  ui.error = name.error ?? "";
  if (ui.error) return render();
  const own = $("f-own").value;
  rememberName(name.name);
  await run({ t: "audience", name: name.name, ownTeam: own === "" ? null : Number(own) });
}

async function submitRename(event) {
  event.preventDefault();
  const team = teamName(value("f-rename"));
  ui.error = team.error ?? "";
  if (ui.error) return render();
  const reply = await run({ t: "rename", team: team.name });
  if (reply.t === "ok") ui.mode = "start";
  render();
}

const go = (mode) => () => {
  ui.mode = mode;
  ui.error = "";
  ui.found = null;
  ui.lateTeam = null;
  ui.joiningLate = false;
  render();
};

// ---------- Pieces ----------
const err = () => h("p", { class: "err", role: "alert" }, ui.error);
const submit = (label) => h("button", { class: "uu-btn uu-btn--ink btn-block", type: "submit", disabled: ui.busy }, ui.busy ? "Wait…" : label);
const back = () => h("button", { class: "linkish", type: "button", onclick: go("start") }, "← Back");
const savedName = () => readStore(KEY).name ?? "";

function nameField(label = "Your name") {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field__label" }, label),
    h("input", { class: "input", id: "f-name", name: "name", autocomplete: "name", maxlength: 40, required: true, value: savedName() }),
    h("span", { class: "p-small" }, "As it should appear on your certificate.")
  );
}

function codeField() {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field__label" }, "Team code"),
    h("input", { class: "input input--code", id: "f-code", name: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 6, inputmode: "text", required: true })
  );
}

function countdown(label, endAt, offset = null) {
  return h(
    "div",
    { class: "countdown" },
    h("span", { class: "countdown__label" }, label),
    h("span", { class: "countdown__value", dataset: { end: endAt, ...(offset === null ? {} : { offset }) } }, "–:––")
  );
}

function featureCards(team, { canSwap, animate }) {
  return h(
    "div",
    { class: "cards" },
    team.cards.map((card, slot) =>
      h(
        "div",
        { class: `uu-card feature${animate ? " flip" : ""}` },
        h("span", { class: "uu-card__kind" }, team.cards.length > 1 ? `Feature ${slot + 1} · ruin it` : "Your feature · ruin it"),
        h("p", { class: "uu-card__name" }, card.name),
        canSwap ? h("button", { class: "uu-btn feature__swap", type: "button", onclick: () => swap(card, slot) }, team.cards.length > 1 ? "Swap this one" : "Swap it") : null
      )
    )
  );
}

function teamWindow(view) {
  const team = view.team;
  const body = [
    h("p", { class: "team__name" }, team.name),
    view.phase === "join" || view.phase === "deal"
      ? h("div", { class: "code" }, h("span", { class: "mono", style: "font-size:11px" }, "Team code"), h("span", { class: "code__value" }, team.code), h("span", { class: "code__hint" }, "Your teammates join with this. Keep it: it gets you back in if your phone drops."))
      : h("p", { class: "p-small" }, `Team code: ${team.code}`),
    h(
      "ul",
      { class: "members" },
      team.members.map((m) => h("li", {}, h("span", { class: `dot${m.online ? " dot--on" : ""}`, title: m.online ? "Online" : "Offline" }), m.name, m.you ? h("em", {}, "You") : null))
    ),
  ];
  if (view.phase === "join") body.push(h("p", { class: "p-small" }, `Up to ${view.maxSize} in a team.`));
  const actions = [];
  if (view.canRename) actions.push(h("button", { class: "uu-btn", type: "button", onclick: go("rename") }, "Rename team"));
  if (view.canLeave) actions.push(h("button", { class: "uu-btn", type: "button", onclick: leave }, "Leave team"));
  if (actions.length) body.push(h("div", { class: "team__actions" }, actions));
  return h("section", { class: "uu-window team", "aria-label": "Your team" }, h("div", { class: "uu-window__bar" }, h("span", {}, "YOUR_TEAM.EXE"), h("span", {}, "× (decorative)")), h("div", { class: "uu-window__body" }, body));
}

function linkForm(withCode) {
  return h(
    "form",
    { class: "form", onsubmit: submitLink, novalidate: true },
    withCode ? codeField() : null,
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your site's share link"), h("input", { class: "input", id: "f-url", type: "url", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: 400, placeholder: "https://…" })),
    h("p", { class: "p-small" }, "Open it on a phone that isn't logged in first, to check it works for everyone."),
    err(),
    submit("Send the link")
  );
}

function showSlab(show, strip = false) {
  if (!show) return null;
  // Under the stickers: one line, so the site and the sheet fit on the screen.
  if (strip && show.current && !(typeof show.upIn === "number" && show.upIn >= 0 && show.upIn <= 1)) return h("div", { class: "strip" }, h("span", {}, `On stage · ${show.current.slot + 1}/${show.total}`), h("b", {}, show.current.name));
  if (show.finished) return h("div", { class: "slab" }, h("p", { class: "slab__small" }, "Presenting"), h("p", { class: "slab__big" }, "That's everyone"));
  const cur = show.current;
  const parts = [h("p", { class: "slab__small" }, cur ? `Now presenting · ${cur.slot + 1} of ${show.total}` : "Presenting")];
  if (cur) parts.push(h("p", { class: "slab__big" }, cur.name));
  if (show.upIn === 0) parts.push(h("p", { class: "slab__small" }, "That's you: go to the front"));
  else if (show.upIn === 1) parts.push(h("p", { class: "slab__small" }, "You're next: get ready"));
  else if (show.upIn > 1) parts.push(h("p", { class: "slab__small" }, `You're on in ${show.upIn} teams`));
  return h("div", { class: "slab" }, parts);
}

function awardsList(results, ownTeam) {
  if (!results) return null;
  if (results.awards.length === 0) return h("p", { class: "note" }, "Look up: the winners are about to be revealed.");
  return h(
    "ul",
    { class: "awards" },
    [...results.awards].reverse().map((a) => h("li", { class: `award${a.team && a.team.id === ownTeam ? " award--yours" : ""}` }, h("span", { class: "award__title" }, a.title), h("span", { class: "award__team" }, a.team ? a.team.name : "Nobody earned this one")))
  );
}

function stickerSection(view) {
  if (!view.stickers) return null;
  stickers.update(view.stickers, view.you.id, view.show?.current?.teamId ?? null);
  return stickers.root;
}

// ---------- Screens ----------
function startScreen(who) {
  const open = who?.open ?? true;
  if (who?.stickers && ui.mode === "audience") {
    return [
      back(),
      h("h1", { class: "p-title" }, "Stickers"),
      h("p", { class: "p-sub" }, "Slap stickers on the sites you love (or hate). Four side quests are decided by your stickers."),
      h(
        "form",
        { class: "form", onsubmit: submitAudience, novalidate: true },
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), h("input", { class: "input", id: "f-name", autocomplete: "name", maxlength: 40, value: savedName() })),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Your team (you can't sticker it)"), h("select", { class: "select", id: "f-own" }, h("option", { value: "" }, "Not in a team"), (who.teams ?? []).map((t) => h("option", { value: t.id }, t.name)))),
        err(),
        submit("Get my stickers")
      ),
    ];
  }
  if (who?.stickers) {
    return [
      h("p", { class: "p-kicker" }, "Presenting now"),
      h("h1", { class: "p-title" }, "Get your", h("br"), "stickers"),
      h(
        "div",
        { class: "choices" },
        h("button", { class: "uu-btn uu-btn--red", type: "button", onclick: go("audience") }, "Just here for stickers", h("small", {}, "Start")),
        h("button", { class: "uu-btn uu-btn--ink", type: "button", onclick: go("back") }, "I'm in a team", h("small", {}, "Team code"))
      ),
    ];
  }
  if (who?.links && ui.mode !== "back" && ui.mode !== "back-name") {
    return [
      h("p", { class: "p-kicker" }, "Links are open"),
      h("h1", { class: "p-title" }, "Send your", h("br"), "site"),
      h("p", { class: "p-sub" }, "One person per team: your team code, then your site's link."),
      linkForm(true),
      h("button", { class: "linkish", type: "button", onclick: go("back") }, "Get back into my team instead"),
    ];
  }
  if (who?.phase === "results" && ui.mode !== "back" && ui.mode !== "back-name") return [h("h1", { class: "p-title" }, "Look up"), awardsList(who.results, null)];
  if (!open) {
    return [
      h("h1", { class: "p-title" }, "Teams are set"),
      h("p", { class: "p-sub" }, "Already in a team? Get back in with your team code."),
      h("div", { class: "choices" }, h("button", { class: "uu-btn uu-btn--ink", type: "button", onclick: go("back") }, "I was already in", h("small", {}, "Team code"))),
      h("p", { class: "p-small" }, "Not in a team? Ask an organiser."),
    ];
  }
  return [
    h("h1", { class: "sr-only" }, "User unfriendly"),
    logo(),
    h("p", { class: "p-sub" }, "Good UI. Bad UX. Get into a team of up to ", String(who?.maxSize ?? 4), "."),
    h(
      "div",
      { class: "choices" },
      h("button", { class: "uu-btn uu-btn--red", type: "button", onclick: go("make"), disabled: who && !who.canMake }, "Make a team", h("small", {}, who && !who.canMake ? "All made" : "Get a code")),
      h("button", { class: "uu-btn uu-btn--ink", type: "button", onclick: go("join") }, "Join a team", h("small", {}, "Have a code")),
      h("button", { class: "uu-btn", type: "button", onclick: go("pool") }, "Find me a team", h("small", {}, "On my own")),
      h("button", { class: "uu-btn", type: "button", onclick: go("back") }, "I was already in", h("small", {}, "Get back in"))
    ),
    who && !who.canMake ? h("p", { class: "p-small" }, "All the teams are made. Join one with its code, or tap FIND ME A TEAM.") : null,
  ];
}

function makeScreen() {
  return [
    back(),
    h("h1", { class: "p-title" }, "Make a team"),
    h("form", { class: "form", onsubmit: submitMake, novalidate: true }, nameField(), h("label", { class: "field" }, h("span", { class: "field__label" }, "Team name"), h("input", { class: "input", id: "f-team", name: "team", autocomplete: "off", maxlength: 24, required: true })), err(), submit("Make it")),
  ];
}

function joinScreen() {
  return [back(), h("h1", { class: "p-title" }, "Join a team"), h("form", { class: "form", onsubmit: submitJoin, novalidate: true }, nameField(), codeField(), err(), submit("Join"))];
}

function poolScreen() {
  return [
    back(),
    h("h1", { class: "p-title" }, "Find me a team"),
    h("p", { class: "p-sub" }, "An organiser puts you in a team with other people who came on their own."),
    h("form", { class: "form", onsubmit: submitPool, novalidate: true }, nameField(), err(), submit("Find me a team")),
  ];
}

async function submitLateJoin(event) {
  event.preventDefault();
  const name = personName(value("f-name"));
  ui.error = name.error ?? "";
  if (ui.error) return render();
  rememberName(name.name);
  await run({ t: "join", name: name.name, code: ui.lateTeam.code });
}

function backScreen(byName) {
  if (ui.joiningLate && ui.lateTeam) {
    return [
      back(),
      h("h1", { class: "p-title" }, "Join ", ui.lateTeam.name),
      h("form", { class: "form", onsubmit: submitLateJoin, novalidate: true }, nameField(), err(), submit("Join the team")),
    ];
  }
  const parts = [back(), h("h1", { class: "p-title" }, "Get back in")];
  if (ui.found) {
    parts.push(
      h("p", { class: "p-sub" }, "Which one is you?"),
      h(
        "div",
        { class: "pick" },
        ui.found.map((p) => h("button", { class: "uu-btn", type: "button", disabled: ui.busy, onclick: () => claim(p) }, p.name, h("small", {}, p.team ?? "Waiting for a team")))
      ),
      err(),
      ui.lateTeam
        ? h("button", { class: "linkish", type: "button", onclick: () => ((ui.joiningLate = true), render()) }, "I'm not on the list: join this team")
        : h("button", { class: "linkish", type: "button", onclick: () => ((ui.found = null), render()) }, "None of these")
    );
    return parts;
  }
  if (byName) {
    parts.push(h("p", { class: "p-sub" }, "Type your name exactly as you did at the start."), h("form", { class: "form", onsubmit: submitFind, novalidate: true }, nameField(), err(), submit("Find me")));
  } else {
    parts.push(
      h("p", { class: "p-sub" }, "Type your team's code. Any teammate can see it on their phone."),
      h("form", { class: "form", onsubmit: submitLookup, novalidate: true }, codeField(), err(), submit("Find my team")),
      h("button", { class: "linkish", type: "button", onclick: go("back-name") }, "No code? Find me by name")
    );
  }
  return parts;
}

function audienceScreen(view) {
  if (view.phase === "results") return [h("h1", { class: "p-title" }, "Look up"), awardsList(view.results, null)];
  return [showSlab(view.show, true), stickerSection(view)];
}

function personScreen(view) {
  if (view.you.role === "audience") return audienceScreen(view);
  if (!view.team && ["make", "join", "pool"].includes(ui.mode)) return { make: makeScreen, join: joinScreen, pool: poolScreen }[ui.mode]();
  if (!view.team) {
    if (view.waiting) {
      return [
        h("h1", { class: "p-title" }, "Hang on,", h("br"), view.you.name),
        h("p", { class: "note" }, "You're on the list. An organiser will put you in a team soon. Keep this page open."),
        view.phase === "join" || view.phase === "deal" ? h("div", { class: "choices" }, h("button", { class: "uu-btn", type: "button", onclick: go("join") }, "I have a team code after all", h("small", {}, "Join"))) : null,
      ];
    }
    return startScreen(ui.who ?? { open: view.phase === "join" || view.phase === "deal", canMake: view.canMake, maxSize: view.maxSize });
  }
  if (ui.mode === "rename") {
    return [
      back(),
      h("h1", { class: "p-title" }, "Rename team"),
      h("form", { class: "form", onsubmit: submitRename, novalidate: true }, h("label", { class: "field" }, h("span", { class: "field__label" }, "New team name"), h("input", { class: "input", id: "f-rename", maxlength: 24, value: view.team.name })), err(), submit("Save")),
    ];
  }
  const team = view.team;
  const parts = [];
  if (view.phase === "join") {
    parts.push(h("h1", { class: "p-title" }, "You're in"), teamWindow(view), h("p", { class: "note" }, "When everyone's in a team, the host deals each team a feature to ruin. Watch this phone."));
  } else if (view.phase === "deal") {
    parts.push(h("h1", { class: "p-title" }, "Your features"));
    if (team.canSwap) parts.push(countdown("Swap one card · time left", team.swapUntil));
    else if (team.swapped) parts.push(h("p", { class: "note" }, "You've used your swap. These are yours."));
    const cardKey = team.cards.map((c) => c.id).join();
    const animate = cardKey !== ui.cardsShown;
    ui.cardsShown = cardKey;
    parts.push(featureCards(team, { canSwap: team.canSwap, animate }), h("p", { class: "p-sub" }, "Build a site that looks great, where this is horrible to use."), teamWindow(view));
  } else if (view.phase === "build") {
    parts.push(h("h1", { class: "p-title" }, "Build it"), countdown(`Pencils down at ${timeOfDay(view.build.endAt)}`, view.build.endAt));
    if (view.links.open) {
      parts.push(
        h("section", { class: "uu-window team" }, h("div", { class: "uu-window__bar" }, h("span", {}, "SEND_LINK.EXE"), h("span", {}, team.link ? "Sent ✓" : "Not sent")), h("div", { class: "uu-window__body" }, team.link ? h("p", { class: "p-sub" }, team.link.ownLaptop ? "Your team shows its own laptop." : `Sent: ${team.link.host}. Send again to change it.`) : h("p", { class: "p-sub" }, "One of you: paste your site's share link."), linkForm(false)))
      );
    }
    parts.push(featureCards(team, { canSwap: false }), h("p", { class: "p-sub" }, "Make it look great. Make this horrible to use."), teamWindow(view));
  } else if (view.phase === "present") {
    parts.push(showSlab(view.show, Boolean(view.stickers)), stickerSection(view));
  } else if (view.phase === "results") {
    parts.push(h("h1", { class: "p-title" }, "Look up"), awardsList(view.results, team.id));
  }
  if (ui.error) parts.push(err());
  return parts;
}

// The server is stopped during the build: the phone keeps showing what it last knew.
function cachedScreen(cache) {
  const parts = [h("h1", { class: "p-title" }, cache.phase === "build" ? "Build it" : "Your features")];
  if (cache.build) parts.push(countdown(`Pencils down at ${timeOfDay(cache.build.endAt)}`, cache.build.endAt, cache.offset ?? 0));
  parts.push(featureCards(cache.team, { canSwap: false }), h("p", { class: "note" }, "The event's server is resting. Your team and features are saved here."));
  return parts;
}

function messageScreen(title, text, button, action) {
  return [h("h1", { class: "p-title" }, title), h("p", { class: "p-sub" }, text), button ? h("button", { class: "uu-btn uu-btn--ink btn-block", type: "button", onclick: action }, button) : null];
}

function screen() {
  if (ui.status === "moved") return { key: "moved", nodes: messageScreen("Open on another phone", "You're in on another phone or tab now.", "Use this phone", () => net.reconnect()) };
  if (ui.status === "removed") {
    return {
      key: "removed",
      nodes: messageScreen("An organiser removed you", "If that's a mistake, ask them. You can start again.", "Start again", () => {
        writeStore(KEY, { id: null, cache: null });
        location.reload();
      }),
    };
  }
  if (ui.view) return { key: null, nodes: personScreen(ui.view) };
  const cache = readStore(KEY).cache;
  if (ui.status !== "online" && cache?.team) return { key: null, nodes: cachedScreen(cache) };
  if (!ui.who) return { key: "connecting", nodes: [h("h1", { class: "p-title" }, "Connecting…"), h("p", { class: "p-sub" }, "One moment.")] };
  const nodes = { make: makeScreen, join: joinScreen, pool: poolScreen, back: () => backScreen(false), "back-name": () => backScreen(true) }[ui.mode]?.() ?? startScreen(ui.who);
  return { key: null, nodes };
}

function stateLabel() {
  const cache = readStore(KEY).cache;
  if (ui.status === "online") return ["Live", false];
  if (ui.status === "restarting") return ["Server restarting", true];
  if (cache?.phase === "build" || ui.view?.phase === "build") return ["Server resting", false];
  if (!ui.everOnline) return ["Connecting…", false];
  if (ui.offlineSince && Date.now() - ui.offlineSince > LOST_MS) return ["Lost: scan the new QR", true];
  return ["Reconnecting…", true];
}

function render() {
  const [label, warn] = stateLabel();
  $("state").textContent = label;
  $("state").classList.toggle("phone__state--warn", warn);
  const { key, nodes } = screen();
  // Only rebuild when what's shown changed, so typing isn't interrupted.
  const sig = key ?? JSON.stringify({ mode: ui.mode, view: ui.view && { ...ui.view, serverNow: 0 }, who: ui.who && { ...ui.who, serverNow: 0 }, found: ui.found, late: ui.joiningLate && ui.lateTeam, error: ui.error, busy: ui.busy, online: ui.status === "online" });
  if (sig === lastShown) return;
  lastShown = sig;
  replaceKeeping($("main"), nodes.filter(Boolean));
  tickClocks();
}

function tickClocks() {
  for (const el of document.querySelectorAll("[data-end]")) {
    const offset = el.dataset.offset === undefined ? null : Number(el.dataset.offset);
    const now = offset === null ? net.serverNow() : Date.now() + offset;
    el.textContent = clock(Number(el.dataset.end) - now);
  }
}
setInterval(() => {
  tickClocks();
  // The status label ages (RECONNECTING → LOST) without any message arriving.
  const [label, warn] = stateLabel();
  if ($("state").textContent !== label) {
    $("state").textContent = label;
    $("state").classList.toggle("phone__state--warn", warn);
  }
}, 250);

// Keep the screen on while the event is on this phone (https only).
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch {
    // Not allowed (plain http, low battery): the phone may dim. That's fine.
  }
}
document.addEventListener("visibilitychange", keepAwake);
document.addEventListener("pointerdown", keepAwake, { once: true });

render();
