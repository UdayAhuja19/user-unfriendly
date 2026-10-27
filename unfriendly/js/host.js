// The host panel, on the laptop's own screen (the projector shows the big screen). Everything
// that changes the event is a button here, and anything that can't be undone asks first.
import { connectLocal } from "./link.js";
import { $, h, ask, toast, clock, timeOfDay } from "./ui.js";

let view = null;
let join = null;
let lastSig = "";
let waitingToRender = false;
let buildMinutes = 55;
let presentMinutes = 40;
let pinShown = false;
let demoWindow = null; // the tab the current team's site is open in

const link = connectLocal("host", {
  onMessage(msg) {
    if (msg.t === "host") {
      view = msg;
      join = msg.join ?? join;
    }
    if (msg.t === "join") join = msg;
    render();
  },
  onStatus(on) {
    $("conn").textContent = on ? "Server running" : "Server stopped";
    $("conn").style.color = on ? "" : "var(--uu-red)";
  },
});

async function command(t, payload, success) {
  const result = await link.command(t, payload);
  if (result.error) toast(result.error, 5000);
  else if (success) toast(success);
  return result;
}

// ---------- Pieces ----------
function stepper(label, value, onChange, { min, max }) {
  return h(
    "div",
    { class: "row" },
    h("span", { class: "field__label", style: "min-width: 9em" }, label),
    h(
      "span",
      { class: "stepper" },
      h("button", { type: "button", "aria-label": `Fewer: ${label}`, disabled: value <= min, onclick: () => onChange(value - 1) }, "−"),
      h("output", {}, String(value)),
      h("button", { type: "button", "aria-label": `More: ${label}`, disabled: value >= max, onclick: () => onChange(value + 1) }, "+")
    )
  );
}

function settingsPanel(v) {
  const people = v.counts.people;
  const each = v.maxTeams > 0 ? (people / v.maxTeams).toFixed(1) : "–";
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "Teams"),
    stepper("Number of teams", v.maxTeams, (n) => command("settings", { maxTeams: n }), { min: Math.max(1, v.counts.teams), max: 40 }),
    stepper("Up to, per team", v.maxSize, (n) => command("settings", { maxSize: n }), { min: 2, max: 8 }),
    h("p", { class: "p-small" }, `${people} people, ${v.counts.teams} teams made, ${v.counts.waiting} waiting. ${people} ÷ ${v.maxTeams} teams ≈ ${each} each.`),
    h("p", { class: "p-small" }, "About 40 people: 10 teams. About 60: 15. Phones can make new teams until this number is reached.")
  );
}

// The join QR, always on the host panel: for anyone joining after the big screen has moved on
// (the deal, the build). SHOW BIG fills the laptop screen with it; it's the same link as the big
// screen's QR, so it's fine for anyone to see. Team codes stay hidden behind it.
function joinPanel() {
  if (!join?.url) return h("section", { class: "panel" }, h("h2", {}, "Phones join here"), h("p", { class: "p-small" }, join?.tunnel === "missing" ? "cloudflared isn't installed, so there's no link for phones." : "Starting the link…"));
  const qr = h("div", { class: "host-qr__code" });
  qr.innerHTML = join.qr ?? ""; // our own SVG, made on this laptop
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "Phones join here"),
    h(
      "div",
      { class: "host-qr" },
      qr,
      h(
        "div",
        { class: "host-qr__side" },
        h("p", { class: "p-small" }, "For anyone joining late, after the big screen's QR is gone. Turn the laptop round, or:"),
        h("button", { class: "uu-btn uu-btn--ink small-btn", type: "button", onclick: showBigQr }, "Show big"),
        h("code", { class: "host-qr__url" }, join.url.replace(/^https?:\/\//, ""))
      )
    )
  );
}

function showBigQr() {
  if (!join?.qr) return;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => event.key === "Escape" && close();
  const code = h("div", { class: "qr-big__code" });
  code.innerHTML = join.qr;
  const overlay = h("div", { class: "qr-big", role: "dialog", "aria-label": "Join QR code", onclick: close }, h("p", { class: "qr-big__title" }, "Scan to join"), code, h("p", { class: "qr-big__url" }, join.url.replace(/^https?:\/\//, "")), h("p", { class: "qr-big__hint" }, "Click anywhere or press Esc to close"));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
}

// Add a team: late arrivals or a team formed on the spot, at any time before the results.
// What's typed is kept here, so a redraw of the panel never loses it.
const draft = { name: "", members: "" };
function addTeamPanel(v) {
  if (v.phase === "results") return null;
  const submit = async (event) => {
    event.preventDefault();
    const members = draft.members.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    const where = { join: "", deal: "It's dealt its feature straight away.", build: "It's dealt its feature straight away.", present: "It's dealt its feature and goes to the end of the running order." }[v.phase] ?? "";
    const who = members.length ? `Members: ${members.join(", ")}.` : "No members yet: they join from their phones with the team code.";
    if (!(await ask(`Add ${draft.name.trim() || "this team"}?`, `${who}\n${where}`, { yes: "Add team", no: "Cancel" }))) return;
    const result = await command("addTeam", { name: draft.name, members });
    if (result.error) return;
    draft.name = "";
    draft.members = "";
    lastSig = "";
    render();
    await ask(
      `Team code: ${result.code}`,
      "Tell the team (not the room). On their phones: open the app, tap I was already in (or I'm in a team), type the code, then tap their name, or \"I'm not on the list\" to join.",
      { yes: "Done", no: "Close", bar: "TEAM ADDED" }
    );
  };
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "Add a team"),
    h("p", { class: "p-small" }, v.phase === "join" ? "Phones make their own teams now. Use this for people without a phone." : "For a team that arrives late or forms on the spot. It gets a code and a feature, and if presenting has started, the last slot."),
    h(
      "form",
      { class: "form", onsubmit: submit, novalidate: true },
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Team name"), h("input", { class: "input", id: "add-team-name", maxlength: 24, autocomplete: "off", value: draft.name, oninput: (e) => (draft.name = e.target.value) })),
      h(
        "label",
        { class: "field" },
        h("span", { class: "field__label" }, "Members, one per line (optional)"),
        h("textarea", { class: "input", id: "add-team-members", rows: 4, oninput: (e) => (draft.members = e.target.value) }, draft.members)
      ),
      h("button", { class: "uu-btn uu-btn--ink btn-block", type: "submit" }, "Add team")
    )
  );
}

function phasePanel(v) {
  const now = link.serverNow();
  const parts = [h("h2", {}, { join: "1 · Join", deal: "2 · The deal", build: "3 · Build" }[v.phase] ?? v.phase)];
  if (v.phase === "join") {
    parts.push(h("p", {}, "When everyone has a team, deal the cards. Anyone still waiting has to be grouped first."));
    parts.push(
      h(
        "button",
        {
          class: "uu-btn uu-btn--red btn-block",
          type: "button",
          onclick: async () => {
            if (await ask("Deal the cards?", `${v.counts.teams} teams get one feature each. You can undo it for two minutes.`, { yes: "Deal", no: "Not yet" })) command("deal", {}, "DEALT.");
          },
        },
        "Deal the cards"
      )
    );
  } else if (v.phase === "deal") {
    const open = v.teams.filter((t) => t.canSwap).length;
    parts.push(h("p", {}, `Dealt at ${timeOfDay(v.dealAt)}. ${open} ${open === 1 ? "team" : "teams"} can still swap.`));
    if (v.canUndoDeal) {
      parts.push(
        h(
          "button",
          {
            class: "uu-btn",
            type: "button",
            onclick: async () => {
              if (await ask("Undo the deal?", "Every team's cards go back. You'll deal again.", { yes: "Undo", no: "Keep" })) command("undoDeal", {}, "UNDONE.");
            },
          },
          "Undo the deal"
        )
      );
    }
    const minutes = h("input", { class: "input", id: "build-minutes", type: "number", min: 1, max: 180, value: buildMinutes, style: "width: 6em", oninput: (event) => (buildMinutes = Number(event.target.value)) });
    parts.push(
      h("div", { class: "row" }, h("span", { class: "field__label" }, "Build minutes"), minutes),
      h(
        "button",
        {
          class: "uu-btn uu-btn--red btn-block",
          type: "button",
          onclick: async () => {
            const m = buildMinutes;
            const end = link.serverNow() + m * 60_000;
            if (await ask(`Start the ${m}-minute build?`, `Pencils down at about ${timeOfDay(end)}. The big screen counts down, even with the server stopped.`, { yes: "Start", no: "Not yet" })) command("buildStart", { minutes: m }, "BUILD STARTED.");
          },
        },
        "Start the build"
      )
    );
  } else if (v.phase === "build") {
    const end = v.build.endAt;
    parts.push(
      h("p", {}, "Pencils down at ", h("b", {}, timeOfDay(end)), " (", h("span", { dataset: { end } }, clock(end - now)), " left)."),
      h(
        "div",
        { class: "row" },
        [-5, -1, 1, 5].map((m) => h("button", { class: "uu-btn small-btn", type: "button", onclick: () => command("nudge", { ms: m * 60_000 }) }, `${m > 0 ? "+" : "−"}${Math.abs(m)} min`))
      ),
      h("p", { class: "p-small" }, "You can stop the server now (Ctrl+C). The big screen keeps counting, and everything is saved. Start it again at about 17:00 for the links."),
      v.clockFile ? h("p", { class: "p-small" }, "If the big screen is ever reloaded with the server stopped, open this file instead (or run npm run unfriendly -- --offline --clock): ", h("code", {}, v.clockFile)) : null
    );
    const linked = v.teams.filter((t) => t.link).length;
    if (!v.links.open) {
      parts.push(h("button", { class: "uu-btn uu-btn--ink btn-block", type: "button", onclick: () => command("linksOpen", {}, "LINKS ARE OPEN.") }, "Open links (QR on the big screen)"));
    } else {
      parts.push(
        h("p", {}, `Links open until ${timeOfDay(v.links.closeAt)}. ${linked} of ${v.teams.length} teams have sent one.`),
        h("div", { class: "row" }, h("button", { class: "uu-btn small-btn", type: "button", onclick: () => command("linksExtend", { ms: 5 * 60_000 }, "+5 MINUTES.") }, "Links +5 min"))
      );
    }
    const minutes = h("input", { class: "input", id: "present-minutes", type: "number", min: 1, max: 180, value: presentMinutes, style: "width: 6em", oninput: (e) => (presentMinutes = Number(e.target.value)) });
    parts.push(
      h("div", { class: "row" }, h("span", { class: "field__label" }, "Presenting minutes"), minutes),
      h(
        "button",
        {
          class: "uu-btn uu-btn--red btn-block",
          type: "button",
          onclick: async () => {
            const early = v.build.endAt > link.serverNow() ? " Pencils down hasn't come yet." : "";
            const missing = v.teams.length - linked;
            if (await ask("Start presenting?", `The running order is shuffled. ${missing ? `${missing} ${missing === 1 ? "team has" : "teams have"} no link yet.` : "Every team has a link."}${early}`, { yes: "Start", no: "Not yet" })) command("presentStart", { minutes: presentMinutes }, "PRESENTING.");
          },
        },
        "Start presenting"
      )
    );
  } else if (v.phase === "present") {
    const cur = v.order.find((o) => o.state !== "done" && o.state !== "waiting");
    const team = cur ? v.teams.find((t) => t.id === cur.teamId) : null;
    const behind = v.presentAt && v.budgetMs ? Math.round((now - v.presentAt - (v.order.filter((o) => o.state === "done").length * (v.show?.demoMs ?? 0) + v.order.filter((o) => o.state === "done").length * 20_000)) / 1000) : 0;
    parts.push(h("p", {}, `Demos are ${Math.round((v.show?.demoMs ?? 0) / 1000)} s each. `, behind > 30 ? h("b", { style: "color: var(--uu-red)" }, `${Math.floor(behind / 60)}:${String(behind % 60).padStart(2, "0")} behind.`) : h("b", {}, "On time.")));
    if (team) {
      parts.push(
        h("p", { class: "hteam__name" }, `${cur.slot + 1}/${v.order.length} · ${team.name}`),
        team.link ? (team.link.ownLaptop ? h("p", { class: "warn" }, "Own laptop: plug it into the HDMI.") : h("p", { class: "p-small" }, team.link.url)) : h("p", { class: "warn" }, "No link. Paste one in the team's card, or plug in their laptop."),
        h(
          "div",
          { class: "row" },
          team.link?.url ? h("button", { class: "uu-btn uu-btn--ink", type: "button", onclick: () => openSite(team.link.url) }, "Open site") : null,
          h("button", { class: "uu-btn uu-btn--red", type: "button", onclick: () => command("demoStart", {}) }, cur.state === "intro" ? "Start demo" : "Restart demo"),
          h(
            "button",
            {
              class: "uu-btn",
              type: "button",
              onclick: () => {
                closeSite();
                command("next", {});
              },
            },
            cur.state === "intro" ? "Skip" : "Next team"
          )
        ),
        cur.state === "intro" ? h("button", { class: "linkish", type: "button", onclick: () => command("toEnd", { teamId: team.id }, "MOVED TO THE END.") }, "Not ready? Move to the end") : null,
        h("p", { class: "p-small" }, `Judges' ratings for this team: ${team.ratings}. Stickers: ${team.stickers}.`)
      );
    } else {
      parts.push(
        h("p", {}, "Every team has presented."),
        h(
          "button",
          {
            class: "uu-btn uu-btn--red btn-block",
            type: "button",
            onclick: async () => {
              if (await ask("Close stickers and work out the winners?", "Stickers stop and the results are frozen. Then reveal them one at a time.", { yes: "Results", no: "Not yet" })) command("resultsStart", {}, "RESULTS READY.");
            },
          },
          "Results"
        )
      );
    }
    parts.push(h("ol", { class: "lines" }, v.order.map((o) => h("li", { style: o.state === "done" ? "text-decoration: line-through" : o === cur ? "font-weight: 900" : "" }, o.name))));
  } else if (v.phase === "results") {
    const all = v.resultsAll?.awards ?? [];
    const step = v.results?.step ?? 0;
    const ended = v.results?.ended === true;
    const next = ended ? null : all[step] ? h("b", {}, `${all[step].title} → ${all[step].team?.name ?? "nobody"}`) : h("b", {}, "the end screen (thanks, user unfriendly)");
    parts.push(
      ended ? h("p", {}, "The end screen is up. It can stay as long as you like. ", h("b", {}, "Back"), " shows the last award again.") : h("p", {}, `Revealed ${step} of ${all.length}. Next: `, next),
      h(
        "div",
        { class: "row" },
        h("button", { class: "uu-btn", type: "button", onclick: () => command("reveal", { back: true }) }, "Back"),
        ended ? null : h("button", { class: "uu-btn uu-btn--red", type: "button", onclick: () => command("reveal", {}) }, step < all.length ? "Reveal next" : "Show the end screen")
      ),
      h("ul", { class: "lines" }, all.map((a) => h("li", {}, `${a.title}: ${a.team?.name ?? "nobody"}`))),
      h("a", { class: "uu-btn uu-btn--ink btn-block", href: "/export/certificates.zip", download: "" }, "Download certificates (zip)"),
      h("p", { class: "p-small" }, "One file with winners.csv, participants.csv, judges.csv and everything.json. Or one at a time: ", h("a", { href: "/export/winners.csv" }, "winners"), " · ", h("a", { href: "/export/participants.csv" }, "participants"), " · ", h("a", { href: "/export/judges.csv" }, "judges"), " · ", h("a", { href: "/export/everything.json" }, "everything"))
    );
  }
  return h("section", { class: "panel" }, parts);
}

// The site opens in its own tab, cut off from this page so it can't touch the app.
function openSite(url) {
  closeSite();
  const w = window.open("about:blank", "uu-demo");
  if (!w) return toast("The browser blocked the new tab. Allow pop-ups for localhost.", 6000);
  w.opener = null;
  w.location = url;
  demoWindow = w;
}
function closeSite() {
  try {
    demoWindow?.close();
  } catch {
    // Already closed.
  }
  demoWindow = null;
}

function judgesPanel(v) {
  if (v.phase !== "build" && v.phase !== "present") return null;
  const judgeUrl = join?.url ? `${join.url}/judge` : null;
  const online = v.judges.filter((j) => j.online).length;
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, `Judges · ${v.judges.length}`),
    h("p", { class: "p-small" }, `${online} online. Share the link and PIN in the organisers' group, never on the big screen.`),
    judgeUrl ? h("p", { class: "p-small" }, h("code", {}, judgeUrl)) : null,
    h(
      "button",
      {
        class: "uu-btn small-btn",
        type: "button",
        onpointerdown: () => ((pinShown = true), (lastSig = ""), render()),
        onpointerup: () => ((pinShown = false), (lastSig = ""), render()),
        onpointerleave: () => pinShown && ((pinShown = false), (lastSig = ""), render()),
      },
      pinShown ? `PIN ${v.judgePin}` : "Hold to show the PIN"
    )
  );
}

function waitingPanel(v) {
  if (v.pool.length === 0 && v.loose.length === 0) return null;
  const parts = [h("h2", {}, `Waiting for a team · ${v.pool.length}`)];
  if (v.pool.length) {
    parts.push(
      h("ul", { class: "pool-list" }, v.pool.map((p) => h("li", {}, h("span", { class: `dot${p.online ? " dot--on" : ""}` }), p.name))),
      h(
        "button",
        {
          class: "uu-btn uu-btn--ink",
          type: "button",
          onclick: async () => {
            const preview = await command("group", { dryRun: true });
            if (preview.error) return;
            const over = preview.over?.length ? `\n\nOver the limit: ${preview.over.join(", ")}.` : "";
            if (await ask("Put them in teams like this?", preview.lines.join("\n") + over, { yes: "Do it", no: "Not yet", bar: "GROUP.EXE" })) command("group", {}, "GROUPED.");
          },
        },
        "Put them in teams"
      )
    );
  }
  if (v.loose.length) {
    parts.push(h("p", { class: "p-small" }, "Left a team and haven't picked again:"), h("ul", { class: "pool-list" }, v.loose.map((p) => h("li", {}, h("span", { class: `dot${p.online ? " dot--on" : ""}` }), p.name))));
  }
  return h("section", { class: "panel" }, parts);
}

function teamCard(v, t) {
  const now = link.serverNow();
  const open = v.phase === "join" || v.phase === "deal";
  const people = t.people.map((p) =>
    h(
      "li",
      {},
      h("span", { class: `dot${p.online ? " dot--on" : ""}`, title: p.online ? "Online" : "Offline" }),
      p.name,
      h(
        "select",
        {
          "aria-label": `Move ${p.name}`,
          style: "margin-left: auto; max-width: 8.5em; font-size: 12px",
          onchange: async (event) => {
            const to = event.target.value;
            event.target.value = "";
            if (to === "") return;
            const teamId = to === "none" ? null : Number(to);
            const name = teamId === null ? "no team" : v.teams.find((x) => x.id === teamId)?.name;
            if (await ask(`Move ${p.name}?`, `To ${name}.`, { yes: "Move", no: "Cancel" })) command("person", { id: p.id, teamId }, "MOVED.");
          },
        },
        h("option", { value: "" }, "Move to…"),
        v.teams.filter((x) => x.id !== t.id).map((x) => h("option", { value: x.id }, x.name)),
        h("option", { value: "none" }, "No team")
      ),
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            if (await ask(`Remove ${p.name}?`, "Their phone is told and let go. They can join again as someone new.", { yes: "Remove", no: "Keep" })) command("person", { id: p.id, remove: true }, "REMOVED.");
          },
        },
        "Remove"
      )
    )
  );
  let swap = null;
  if (t.dealt && (v.phase === "deal" || v.phase === "build")) {
    if (t.swapped) swap = h("span", { class: "chip" }, "Swapped");
    else if (t.canSwap) swap = h("span", { class: "mono", style: "font-size: 12px" }, "Swap open · ", h("span", { dataset: { end: t.swapUntil } }, clock(t.swapUntil - now)));
    else {
      swap = h(
        "button",
        { class: "uu-btn small-btn", type: "button", onclick: () => command("reopenSwap", { teamId: t.id, ms: 120_000 }, "SWAP REOPENED FOR 2 MINUTES.") },
        "Reopen swap · 2 min"
      );
    }
  }
  if (swap && !t.swapped && t.swapHolder) {
    swap = h(
      "div",
      { class: "hteam__swap" },
      swap,
      h("span", { class: "mono", style: "font-size: 12px" }, `Swap held by ${t.swapHolder}`),
      t.people.length > 1 ? h("button", { class: "uu-btn small-btn", type: "button", onclick: () => command("passSwap", { teamId: t.id }, "SWAP PASSED ON.") }, "Pass it on") : null
    );
  }
  return h(
    "article",
    { class: `hteam${t.over ? " hteam--over" : ""}` },
    h("div", { class: "hteam__head" }, h("p", { class: "hteam__name" }, t.name), h("span", { class: "hteam__code" }, t.code)),
    t.over ? h("p", { class: "warn" }, `Over the limit: ${t.people.length} people.`) : null,
    h("ul", {}, people.length ? people : h("li", {}, "Nobody")),
    t.dealt ? h("div", { class: "chips" }, t.cards.map((c) => h("span", { class: "chip" }, c)), t.replaced.map((c) => h("span", { class: "chip chip--old" }, c))) : null,
    swap,
    v.phase === "build" || v.phase === "present"
      ? h(
          "div",
          { class: "row" },
          t.link ? h("span", { class: "chip" }, t.link.ownLaptop ? "Own laptop" : t.link.host) : h("span", { class: "chip chip--old" }, "No link"),
          h(
            "button",
            {
              class: "linkish",
              type: "button",
              onclick: async () => {
                const url = prompt(`Link for ${t.name} (or type LAPTOP for their own laptop):`, t.link?.url ?? "");
                if (url === null) return;
                if (url.trim().toUpperCase() === "LAPTOP") command("hostLink", { teamId: t.id, ownLaptop: true }, "SET.");
                else command("hostLink", { teamId: t.id, url }, "LINK SAVED.");
              },
            },
            "Set link"
          )
        )
      : null,
    open
      ? h(
          "button",
          {
            class: "linkish",
            type: "button",
            onclick: async () => {
              if (await ask(`Remove ${t.name}?`, "Its people go back to waiting for a team.", { yes: "Remove team", no: "Keep" })) command("team", { id: t.id, remove: true }, "TEAM REMOVED.");
            },
          },
          "Remove team"
        )
      : null
  );
}

function render() {
  if (!view) return;
  $("phase").textContent = view.phase;
  $("join").replaceChildren(
    ...(join?.url ? [h("span", {}, join.tunnel === "live" ? "Phones join at" : join.tunnel === "lan" ? "Same Wi-Fi" : join.tunnel === "off" ? "Local only" : join.tunnel), h("a", { href: join.url, target: "_blank", rel: "noopener" }, join.url.replace(/^https?:\/\//, ""))] : [h("span", {}, join?.tunnel === "missing" ? "cloudflared isn't installed" : "Starting the link…")])
  );
  // Don't rebuild while a menu is open or a box is being typed in.
  const active = document.activeElement;
  if (active && (active.tagName === "SELECT" || active.tagName === "INPUT" || active.tagName === "TEXTAREA") && $("side").parentElement.contains(active)) {
    waitingToRender = true;
    return;
  }
  const sig = JSON.stringify({ ...view, serverNow: 0, joinUrl: join?.url ?? null });
  if (sig === lastSig) return;
  lastSig = sig;
  $("side").replaceChildren(...[phasePanel(view), joinPanel(), judgesPanel(view), view.phase === "join" || view.phase === "deal" ? settingsPanel(view) : null, waitingPanel(view), addTeamPanel(view)].filter(Boolean));
  $("teams").replaceChildren(h("div", { class: "teams-grid" }, view.teams.length ? view.teams.map((t) => teamCard(view, t)) : h("p", {}, "No teams yet.")));
}
document.addEventListener("focusout", () => {
  if (waitingToRender) {
    waitingToRender = false;
    setTimeout(render, 0);
  }
});

setInterval(() => {
  $("laptop-time").textContent = new Date().toLocaleTimeString([], { hour12: false });
  for (const el of document.querySelectorAll("[data-end]")) el.textContent = clock(Number(el.dataset.end) - link.serverNow());
}, 250);
