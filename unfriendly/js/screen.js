// The big screen. Shows the room what's happening and never a team code. It keeps whatever it
// last showed while the server is stopped, and the build clock keeps counting from its end time.
import { connectLocal } from "./link.js";
import { $, h, clock, timeOfDay, logo } from "./ui.js";
import { fontsReady, fitSize, pixelWord, dither } from "../brand/user-unfriendly.js";

dither($("edge"), { cols: 240, rows: 10 });

let state = null;
let join = null;
let online = false;
let lastSig = "";
const flipped = new Set(); // teams whose cards have already flipped in

const link = connectLocal("screen", {
  onMessage(msg) {
    if (msg.t === "state") state = msg;
    if (msg.t === "join") join = msg;
    render();
  },
  onStatus(on) {
    online = on;
    topRight();
  },
});

// ---------- The pixel title, drawn once ----------
const title = h("div", { class: "pixel-title", "aria-label": "User unfriendly", role: "img" }, h("canvas", { class: "uu-pixels" }), h("canvas", { class: "uu-pixels" }));
fontsReady().then(() => {
  const [user, unfriendly] = title.querySelectorAll("canvas");
  const look = { tall: 1.25, soften: 0.18, track: 0.07 };
  const size = fitSize("UNFRIENDLY", 46, undefined, look.track);
  pixelWord(unfriendly, "UNFRIENDLY", { size, ...look });
  pixelWord(user, "USER", { size, ...look });
  user.style.aspectRatio = `${unfriendly.width} / ${user.height}`;
});

function topRight() {
  const el = $("top-right");
  if (online) {
    el.textContent = "Event 002 · Room 0411";
    el.className = "";
  } else {
    el.textContent = state?.phase === "build" ? "Server resting · still counting" : "Reconnecting…";
    el.className = "screen__offline";
  }
}

// ---------- Pieces ----------
function wall(teams, { cards }) {
  return h(
    "div",
    { class: "wall", id: "wall" },
    teams.map((t) => {
      const fresh = cards && t.dealt && !flipped.has(t.id);
      if (fresh) flipped.add(t.id);
      return h(
        "article",
        { class: `wteam${cards && t.linked ? " wteam--linked" : ""}` },
        h("p", { class: "wteam__name" }, t.name),
        cards && t.dealt
          ? h("div", { class: "wteam__cards" }, t.cards.map((c) => h("span", { class: `wteam__card${fresh ? " wteam__card--in" : ""}` }, c)))
          : [h("p", { class: "wteam__people" }, t.members.join(" · ") || "Nobody yet"), h("p", { class: "wteam__count" }, `${t.members.length} ${t.members.length === 1 ? "person" : "people"}`)],
        cards && t.swapped ? h("span", { class: "wteam__swapped" }, "Swapped") : null
      );
    })
  );
}

function joinView(s) {
  const qr = h("div", { class: "qrcard__qr" });
  if (join?.qr) qr.innerHTML = join.qr; // our own SVG, made on this laptop
  return h(
    "div",
    { class: "join" },
    h(
      "div",
      { class: "join__title" },
      logo(),
      h("p", { class: "join__lead" }, `Make a team, join one with its code, or tap FIND ME A TEAM. Teams of up to ${s.maxSize}.`),
      h(
        "div",
        { class: "join__counts mono" },
        h("span", {}, h("b", {}, String(s.counts.people)), "People"),
        h("span", {}, h("b", {}, `${s.counts.teams}/${s.maxTeams}`), "Teams"),
        h("span", {}, h("b", {}, String(s.counts.waiting)), "Waiting for a team")
      )
    ),
    h(
      "aside",
      { class: "qrcard" },
      h("span", { class: "qrcard__label" }, "Scan to join"),
      join?.url ? qr : h("p", { class: "qrcard__url" }, join?.tunnel === "missing" ? "No tunnel: cloudflared isn't installed." : "Starting the link…"),
      join?.url ? h("span", { class: "qrcard__url" }, join.url.replace(/^https?:\/\//, "")) : null
    ),
    wall(s.teams, { cards: false })
  );
}

function dealView(s) {
  return h(
    "div",
    { class: "dealview" },
    h("div", { class: "dealview__head" }, h("h1", {}, "The deal"), h("p", { class: "join__lead" }, "Every team has one feature to ruin. One swap each, in the next five minutes.")),
    wall(s.teams, { cards: true })
  );
}

function qrBlock() {
  const qr = h("div", { class: "qrcard__qr" });
  if (join?.qr) qr.innerHTML = join.qr; // our own SVG, made on this laptop
  return qr;
}

function buildView(s) {
  const left = s.build.endAt - link.serverNow();
  const linksCard = s.links.open && join?.url
    ? h("aside", { class: "links-card" }, h("span", {}, "Send your link"), qrBlock(), h("p", {}, `One per team: team code + link. ${s.teams.filter((t) => t.linked).length}/${s.teams.length} in.`))
    : null;
  if (left <= 0 && linksCard) return h("div", { class: "pencils pencils--links" }, h("h1", {}, "Pencils", h("br"), "down"), h("p", {}, "Send your link now", h("br"), "Chairs to the centre"), linksCard);
  if (left <= 0) {
    return h("div", { class: "pencils" }, h("h1", {}, "Pencils", h("br"), "down"), h("p", {}, "Bring your chairs to the centre"));
  }
  return h(
    "div",
    { class: `buildview${linksCard ? " buildview--links" : ""}` },
    h(
      "div",
      { class: "buildview__clock" },
      h("span", { class: "buildview__time", dataset: { end: s.build.endAt } }, clock(left)),
      h("span", { class: "buildview__label" }, "Pencils down at", h("b", {}, timeOfDay(s.build.endAt)))
    ),
    wall(s.teams, { cards: true }),
    linksCard
  );
}

function presentView(s) {
  const show = s.show;
  const stickerQr = join?.url ? h("div", { class: "sticker-qr" }, h("span", {}, "Stickers: scan"), qrBlock()) : null;
  if (!show.current) {
    return h("div", { class: "pencils" }, h("h1", {}, "That's", h("br"), "everyone"), h("p", {}, "Last stickers now · results next"));
  }
  const cur = show.current;
  const left = cur.endsAt ? cur.endsAt - link.serverNow() : null;
  const clockBox =
    cur.state === "intro"
      ? h("div", { class: "present__clock present__clock--over" }, h("span", { class: "mono" }, "Up now"), h("b", {}, clock(show.demoMs)))
      : h("div", { class: `present__clock${left <= 0 ? " present__clock--over" : ""}` }, h("span", { class: "mono" }, left > 0 ? "Demo" : "Time's up"), h("b", { dataset: { end: cur.endsAt } }, clock(left)));
  return h(
    "div",
    { class: "present" },
    h("div", { class: "present__now" }, h("span", { class: "present__label" }, h("span", { class: "tracked" }, h("span", { class: "tag" }, "USER_ON_STAGE"), `Team ${cur.slot + 1} of ${show.total}`)), h("p", { class: "present__name" }, cur.name), h("p", { class: "present__people" }, cur.members.join(" · "))),
    h("div", { class: "present__cards" }, cur.cards.map((c, i) => h("div", { class: "uu-card" }, h("span", { class: "uu-card__kind" }, cur.cards.length > 1 ? `Feature ${i + 1} · ruined` : "The feature · ruined"), h("p", { class: "uu-card__name" }, c)))),
    h("div", { class: "present__side" }, clockBox, stickerQr, h("div", { class: "present__next" }, h("span", { class: "mono" }, "Up next"), show.next.length ? show.next.map((n) => h("span", {}, n)) : h("span", {}, "Nobody: last one"))),
    h("p", { class: "present__foot" }, "Judges are rating · stickers decide the side quests")
  );
}

function resultsView(s) {
  const r = s.results;
  if (!r || r.step === 0) return h("div", { class: "pencils" }, h("h1", {}, "The", h("br"), "results"), h("p", {}, "Four side quests, then User unfriendliest"));
  const a = r.awards[r.step - 1];
  return h(
    "div",
    { class: "reveal", key: r.step },
    h("span", { class: "reveal__title" }, a.key === "main" ? "And the winner of" : "Side quest", " · ", a.title),
    a.team ? h("p", { class: `reveal__team${a.key === "main" ? " reveal__team--main" : ""}` }, a.team.name) : h("p", { class: "reveal__team" }, "Nobody"),
    a.team ? h("p", { class: "reveal__people" }, a.team.members.map((m) => m.name).join(" · ")) : h("p", { class: "reveal__people" }, "Nobody earned this one")
  );
}

function laterView() {
  return h("div", { class: "pencils" }, h("h1", {}, "Presenting", h("br"), "soon"), h("p", {}, "Bring your chairs to the centre"));
}

// The wall shrinks its cards until every team fits: nothing on the big screen may be cut off.
function fitWall() {
  const el = $("wall");
  if (!el) return;
  const fits = () => el.scrollHeight <= el.clientHeight + 1;
  for (const compact of [false, true]) {
    // Last resort: names of the people go, the team names and head-counts stay.
    el.classList.toggle("wall--compact", compact);
    for (const min of [220, 190, 165, 145, 125, 110, 96, 84]) {
      el.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(16vw, ${min}px), 1fr))`;
      if (fits()) return;
    }
  }
}

function render() {
  topRight();
  if (!state) return;
  const ended = state.phase === "build" && state.build && state.build.endAt <= link.serverNow();
  const over = state.show?.current?.endsAt ? state.show.current.endsAt <= link.serverNow() : false;
  const sig = JSON.stringify({ ...state, serverNow: 0, join: join?.url, ended, over });
  if (sig === lastSig) return;
  lastSig = sig;
  const views = { join: joinView, deal: dealView, build: buildView, present: presentView, results: resultsView };
  $("stage").replaceChildren((views[state.phase] ?? laterView)(state));
  requestAnimationFrame(fitWall);
}

// The clock: every frame from the end time, so it's right straight after the laptop wakes.
setInterval(() => {
  for (const el of document.querySelectorAll("[data-end]")) el.textContent = clock(Number(el.dataset.end) - link.serverNow());
  if (state?.phase === "build" && state.build && state.build.endAt <= link.serverNow() && !lastSig.includes('"ended":true')) render();
  if (state?.show?.current?.endsAt && state.show.current.endsAt <= link.serverNow() && !lastSig.includes('"over":true')) render();
}, 250);
window.addEventListener("resize", () => requestAnimationFrame(fitWall));

// Kiosk niceties: F for full screen, and the pointer hides when it's still.
document.addEventListener("keydown", (event) => {
  if (event.key === "f" || event.key === "F") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
});
let pointerTimer = 0;
document.addEventListener("pointermove", () => {
  document.body.style.cursor = "";
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => (document.body.style.cursor = "none"), 3000);
});

// Keep the projector awake (localhost counts as secure).
async function keepAwake() {
  try {
    if (!document.hidden) await navigator.wakeLock?.request("screen");
  } catch {
    // The laptop's own settings and caffeinate keep it on anyway.
  }
}
keepAwake();
document.addEventListener("visibilitychange", keepAwake);
