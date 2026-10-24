// A judge's phone (a club member, through the private link in the organisers' group). Enter the
// PIN, tap your name (or add it), then rate each team as it presents: six blocks, from SUPER POOP
// to LEGENDARY, answering one question: HOW GOOD IS THIS ENTRY? You can change your rating
// until the host moves on. If the link changes after a restart, the PIN and your name get you back.
import { connect, storeKey, readStore, writeStore } from "./net.js";
import { $, h, replaceKeeping, toast, clock } from "./ui.js";
import { personName, PIN_PATTERN } from "./shared/rules.js";
import { dither } from "../brand/user-unfriendly.js";

const KEY = storeKey("judge");
const ui = { status: "connecting", view: null, who: false, pin: readStore(KEY).pin ?? "", judges: null, error: "", busy: false };
let lastSig = "";

const net = connect({
  key: KEY,
  onStatus(status) {
    ui.status = status;
    render();
  },
  onMessage(msg) {
    if (msg.t === "view" && msg.view.you?.role === "judge") ui.view = msg.view;
    else if (msg.t === "view" || msg.t === "who") {
      // This phone is someone else on the participant page, or nobody yet: judge sign-in.
      ui.view = null;
      ui.who = true;
    }
    render();
  },
});
dither($("edge"), { cols: 120, rows: 8, color: "#0D0D0D" });

async function run(msg) {
  ui.busy = true;
  ui.error = "";
  render();
  const reply = await net.act(msg);
  ui.busy = false;
  if (reply.t === "no") ui.error = reply.error;
  render();
  return reply;
}

async function submitPin(event) {
  event.preventDefault();
  const pin = $("f-pin").value.trim();
  if (!PIN_PATTERN.test(pin)) {
    ui.error = "THE PIN IS 4 TO 8 DIGITS.";
    return render();
  }
  const reply = await run({ t: "judges", pin });
  if (reply.t === "found") {
    ui.pin = pin;
    writeStore(KEY, { pin });
    ui.judges = reply.judges;
    render();
  }
}

async function submitNew(event) {
  event.preventDefault();
  const name = personName($("f-name").value);
  ui.error = name.error ?? "";
  if (ui.error) return render();
  await run({ t: "judgeNew", pin: ui.pin, name: name.name });
}

async function claim(judge) {
  let reply = await run({ t: "judgeClaim", pin: ui.pin, personId: judge.id });
  if (reply.t === "no" && reply.elsewhere) reply = await run({ t: "judgeClaim", pin: ui.pin, personId: judge.id, force: true });
}

async function rate(team, value) {
  navigator.vibrate?.(20);
  const reply = await net.act({ t: "rate", team: team.teamId, value });
  if (reply.t === "no") toast(reply.error);
}

const err = () => h("p", { class: "err", role: "alert" }, ui.error);

// The six ratings as a ladder, best at the top: big rows for thumbs, a pixel meter on each.
function ladder(team, compact) {
  const rows = ui.view.ratings.map((label, i) => {
    const value = i + 1;
    const picked = team.rating === value;
    return h(
      "button",
      { class: `rung${picked ? " rung--picked" : ""}`, type: "button", "aria-label": `${label}, ${value} of 6`, "aria-pressed": String(picked), disabled: !team.canRate, onclick: () => rate(team, value) },
      h("span", { class: "rung__n" }, String(value).padStart(2, "0")),
      h("span", { class: "rung__label" }, label),
      compact ? null : h("span", { class: "rung__meter", "aria-hidden": "true" }, ui.view.ratings.map((_, k) => h("i", { class: k < value ? "on" : "" })))
    );
  });
  return h("div", { class: `ladder${compact ? " ladder--compact" : ""}`, role: "group", "aria-label": `Rate ${team.name}` }, compact ? rows : rows.reverse());
}

function stage(team, label) {
  const live = team.state === "running";
  const over = team.state === "overtime";
  return h(
    "section",
    { class: "stage" },
    h(
      "div",
      { class: "stage__top" },
      h("span", {}, label),
      live ? h("span", { class: "stage__live" }, "● Live ", h("span", { dataset: { end: team.endsAt } }, "")) : h("span", { class: "stage__wait" }, over ? "Time's up" : "Up next")
    ),
    h("h1", { class: "stage__name" }, team.name),
    h("div", { class: "stage__cards" }, team.cards.map((c) => h("span", {}, c))),
    h("p", { class: "stage__people" }, team.members.join(" · "))
  );
}

function current(team) {
  return [
    stage(team, `On stage · ${String(team.slot + 1).padStart(2, "0")} / ${String(ui.view.total).padStart(2, "0")}`),
    h("h2", { class: "ask" }, "How good is this entry?"),
    team.canRate ? null : h("p", { class: "ask__hint" }, "Rating opens when the demo starts."),
    ladder(team, false),
    team.rating ? h("p", { class: "saved" }, `Saved: ${ui.view.ratings[team.rating - 1]}. Change it until the host moves on.`) : null,
  ];
}

// The team that just finished, if you didn't rate it: a few seconds left, so it's an alert.
function lastChance(team) {
  return h(
    "section",
    { class: "uu-window late" },
    h("div", { class: "uu-window__bar late__bar" }, h("span", {}, "Last chance to rate"), h("span", { dataset: { end: team.closesAt } }, "")),
    h("div", { class: "late__body" }, h("p", { class: "late__name" }, team.name), ladder(team, true))
  );
}

function screen() {
  if (ui.status === "moved") return [h("h1", { class: "p-title" }, "Open on another phone"), h("button", { class: "uu-btn uu-btn--ink btn-block", type: "button", onclick: () => net.reconnect() }, "Use this phone")];
  const v = ui.view;
  if (v) {
    const head = h("div", { class: "jhead" }, h("span", {}, `Judge · ${v.you.name}`), h("span", {}, `Rated ${v.rated}/${v.total}`));
    if (v.phase !== "present" && v.phase !== "results") return [head, h("h1", { class: "p-title" }, "You're in"), h("p", { class: "note" }, "Rating opens when presenting starts. Keep this page open.")];
    if (v.phase === "results") return [head, h("h1", { class: "p-title" }, "Thanks"), h("p", { class: "note" }, "The results are on the big screen.")];
    if (v.finished && !v.previous) return [head, h("h1", { class: "p-title" }, "That's everyone"), h("p", { class: "note" }, "Thanks for judging.")];
    return [head, v.previous ? lastChance(v.previous) : null, ...(v.current ? current(v.current) : [])];
  }
  if (!ui.who) return [h("h1", { class: "p-title" }, "Connecting…")];
  if (ui.judges) {
    return [
      h("p", { class: "p-kicker" }, "Judges"),
      h("h1", { class: "p-title" }, "Who are you?"),
      ui.judges.length ? h("div", { class: "pick" }, ui.judges.map((j) => h("button", { class: "uu-btn", type: "button", disabled: ui.busy, onclick: () => claim(j) }, j.name, h("small", {}, "That's me")))) : null,
      h(
        "form",
        { class: "form", onsubmit: submitNew, novalidate: true },
        h("label", { class: "field" }, h("span", { class: "field__label" }, ui.judges.length ? "Not on the list? Your name" : "Your name"), h("input", { class: "input", id: "f-name", autocomplete: "name", maxlength: 40 })),
        err(),
        h("button", { class: "uu-btn uu-btn--ink btn-block", type: "submit", disabled: ui.busy }, "I'm judging")
      ),
    ];
  }
  return [
    h("p", { class: "p-kicker" }, "Club members only"),
    h("h1", { class: "p-title" }, "Judges"),
    h("p", { class: "p-sub" }, "The PIN is in the organisers' group."),
    h(
      "form",
      { class: "form", onsubmit: submitPin, novalidate: true },
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Judges' PIN"), h("input", { class: "input input--code", id: "f-pin", inputmode: "numeric", autocomplete: "off", maxlength: 8, value: ui.pin })),
      err(),
      h("button", { class: "uu-btn uu-btn--red btn-block", type: "submit", disabled: ui.busy }, "Go")
    ),
  ];
}

function render() {
  $("state").textContent = ui.status === "online" ? "Live" : ui.status === "connecting" ? "Connecting…" : "Reconnecting…";
  $("state").classList.toggle("phone__state--warn", ui.status !== "online" && ui.status !== "connecting");
  const sig = JSON.stringify({ v: ui.view && { ...ui.view, serverNow: 0 }, who: ui.who, judges: ui.judges, error: ui.error, busy: ui.busy, status: ui.status === "moved" });
  if (sig === lastSig) return;
  lastSig = sig;
  replaceKeeping($("main"), screen().filter(Boolean));
}

setInterval(() => {
  for (const el of document.querySelectorAll("[data-end]")) el.textContent = clock(Number(el.dataset.end) - net.serverNow());
}, 250);
render();
