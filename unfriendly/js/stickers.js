// The sticker game, on the phone only. Pick a team's card, pick a sticker off your sheet, tap the
// card: it slaps on where you tapped, tilted, and everyone looking at that card sees it land.
// Tap one of your own stickers to peel it off (and use it again). Side-quest stickers (one of each, QUEST_EACH)
// decide the side-quest titles; joke stickers are just for fun.
import { h, toast } from "./ui.js";
import { QUESTS, JOKES, stickerKind, isQuest } from "./shared/rules.js";

const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";

// The same sticker always has the same tilt, on every phone.
const tilt = (id) => ((Math.imul(id, 2654435761) >>> 0) % 25) - 12;

export function createStickers(net) {
  let view = null; // { teams, left }
  let me = null;
  let teamId = null;
  let armed = null;
  let liveId = null;
  const seen = new Set(); // teams this phone has been shown, so a newly presenting one opens by itself
  const piles = new Map(); // teamId -> Map(id -> [id, kind, x, y, by])
  const fresh = new Set();
  // Only the pile redraws when someone else sticks one, so a tap in a busy room never lands on a
  // button that's being replaced, and the tray keeps its scroll.
  let pileEl = null;
  let countEl = null;
  let emptyEl = null;
  let lastSig = "";

  const root = h("section", { class: "stickers", "aria-label": "Stickers" });

  function pile(team) {
    if (!piles.has(team)) piles.set(team, new Map());
    return piles.get(team);
  }

  function pick(id) {
    teamId = id;
    net.send({ t: "watch", team: id });
    draw();
  }

  async function slap(event, card) {
    if (event.target.closest?.(".sticker--mine")) return;
    if (!armed) {
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
      return toast("Pick a sticker first, then tap the card.");
    }
    const box = card.getBoundingClientRect();
    const x = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * 1000);
    const y = Math.round(Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) * 1000);
    const kind = armed;
    if (isQuest(kind) && (view.left[kind] ?? 0) <= 0) return toast("Already used. Peel yours off a site to move it.");
    navigator.vibrate?.(25);
    const reply = await net.act({ t: "slap", team: teamId, kind, x, y });
    if (reply.t === "no") return toast(reply.error);
    if (reply.id) {
      pile(teamId).set(reply.id, [reply.id, kind, x, y, me]);
      fresh.add(reply.id);
    }
    if (isQuest(kind) && (view.left[kind] ?? 1) <= 1) {
      armed = null;
      return draw();
    }
    drawPile();
  }

  async function peel(id) {
    const reply = await net.act({ t: "peel", id });
    if (reply.t === "no") return toast(reply.error);
    pile(teamId).delete(id);
    toast("Peeled off. It's back on your sheet.");
    drawPile();
  }

  function sticker([id, kind, x, y, by]) {
    const meta = stickerKind(kind);
    const mine = by === me;
    const el = h(
      "span",
      {
        class: `sticker ${isQuest(kind) ? "sticker--quest" : "sticker--joke"} k-${kind}${mine ? " sticker--mine" : ""}${fresh.has(id) ? " sticker--new" : ""}`,
        style: `left:${x / 10}%; top:${y / 10}%; rotate:${tilt(id)}deg`,
        title: mine ? "Yours: tap to peel it off" : null,
        onclick: mine
          ? (event) => {
              event.stopPropagation();
              peel(id);
            }
          : null,
      },
      meta?.name ?? kind
    );
    fresh.delete(id);
    return el;
  }

  function draw() {
    if (!view) return root.replaceChildren();
    if (view.teams.length === 0) {
      return root.replaceChildren(h("p", { class: "note" }, "Stickers open as each team presents. Your sheet's ready."), tray());
    }
    const newest = view.teams.find((t) => !seen.has(t.id));
    for (const t of view.teams) seen.add(t.id);
    if (!view.teams.some((t) => t.id === teamId) || (newest && newest.id === view.teams[0].id)) return pick(view.teams[0].id);
    const team = view.teams.find((t) => t.id === teamId);
    pileEl = h("div", { class: "pile" });
    countEl = h("span", { class: "site__count" });
    emptyEl = h("p", { class: "site__empty" }, armed ? "Tap anywhere here" : "No stickers yet. Be first.");
    const page = h(
      "div",
      { class: `site__page${armed ? " site__page--armed" : ""}`, onclick: (event) => slap(event, page) },
      pileEl,
      emptyEl,
      armed ? h("span", { class: "site__hint" }, `Tap to stick: ${stickerKind(armed).name}`) : null
    );
    fillPile();
    const scrolls = [...root.querySelectorAll(".stk-teams, .tray__row")].map((el) => el.scrollLeft);
    root.replaceChildren(
      h(
        "div",
        { class: "stk-teams", role: "group", "aria-label": "Teams" },
        view.teams.map((t) => h("button", { type: "button", "aria-pressed": String(t.id === teamId), onclick: () => pick(t.id) }, t.id === liveId ? h("i", { class: "stk-teams__live", "aria-label": "On stage" }) : null, t.name))
      ),
      h(
        "section",
        { class: "site", "aria-label": `${team.name}'s site` },
        h("div", { class: "site__bar" }, h("span", { class: "site__dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { class: "site__url" }, `${slug(team.name)}.site`), countEl),
        h("div", { class: "site__head" }, h("p", { class: "site__name" }, team.name), h("div", { class: "site__cards" }, team.cards.map((c) => h("span", {}, c)))),
        page
      ),
      tray()
    );
    root.querySelectorAll(".stk-teams, .tray__row").forEach((el, i) => (el.scrollLeft = scrolls[i] ?? 0));
  }

  function fillPile() {
    const stuck = [...pile(teamId).values()].sort((a, b) => a[0] - b[0]);
    // The newest 60 (always including your own), so the page stays readable under a big pile.
    pileEl.replaceChildren(...stuck.filter((st, i) => st[4] === me || i >= stuck.length - 60).map(sticker));
    countEl.textContent = `${stuck.length} stuck`;
    emptyEl.hidden = stuck.length > 0;
  }

  function drawPile() {
    if (!pileEl || !root.contains(pileEl)) return draw();
    fillPile();
  }

  // The sheet: a tray along the bottom of the screen, so a sticker is always a thumb away.
  function tray() {
    const arm = (kind) => () => {
      armed = armed === kind ? null : kind;
      navigator.vibrate?.(10);
      draw();
    };
    return h(
      "div",
      { class: "tray" },
      h("p", { class: "tray__label" }, armed ? "Now tap the site above" : "One of each red sticker · they decide the titles · peel to move"),
      h(
        "div",
        { class: "tray__row" },
        QUESTS.map((q) => {
          const left = view?.left[q.kind] ?? 0;
          return h("button", { class: "peel peel--quest", type: "button", "aria-pressed": String(armed === q.kind), "aria-label": `${q.name}, ${left} left`, disabled: left <= 0, onclick: arm(q.kind) }, h("span", {}, q.name), h("b", {}, String(left)));
        }),
        h("i", { class: "tray__gap", "aria-hidden": "true" }),
        JOKES.map((j) => h("button", { class: `peel peel--joke k-${j.kind}`, type: "button", "aria-pressed": String(armed === j.kind), onclick: arm(j.kind) }, h("span", {}, j.name)))
      )
    );
  }

  return {
    root,
    update(stickers, myId, live = null) {
      const sig = JSON.stringify([stickers, myId, live]);
      if (sig === lastSig && root.isConnected) return;
      lastSig = sig;
      me = myId;
      liveId = live;
      view = stickers;
      draw();
    },
    onMessage(msg) {
      if (msg.t === "pile") {
        piles.set(msg.team, new Map(msg.stickers.map((s) => [s[0], s])));
        if (msg.team === teamId) drawPile();
      } else if (msg.t === "pile+") {
        const p = pile(msg.team);
        for (const s of msg.add) {
          if (!p.has(s[0])) fresh.add(s[0]);
          p.set(s[0], s);
        }
        for (const id of msg.del) p.delete(id);
        if (msg.team === teamId) drawPile();
      }
    },
  };
}
