// Pretend phones for rehearsing USER UNFRIENDLY: teams that make and join, judges who rate each
// demo, and sticker fans who slap stickers on teams that have presented. They react to the
// event on their own; you run it from the host panel as usual.
//
//   node scripts/unfriendly-bots.js [teams=12] [phoneUrl=ws://127.0.0.1:3310/ws] [--judges 6] [--fans 20]
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const plain = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const TEAMS = Number(plain[0] ?? 12);
const URL = plain[1] ?? "ws://127.0.0.1:3310/ws";
const JUDGES = opt("--judges", 6);
const FANS = opt("--fans", 20);
const PIN = process.env.UU_JUDGE_PIN ?? opt("--pin", 0);
const KINDS = ["best-ui", "funniest", "creative", "worst-feature", "send-help", "ten", "why", "cancel-ok", "rage"];
const FIRST = ["Aisha", "Omar", "Zoë", "Rayyan", "Nawfal", "Ronak", "Fatima", "Abhi", "Aaron", "Ritu", "Sara", "Yusuf", "Mariam", "Dev", "Priya", "Hamza", "Layla", "Arjun", "Noor", "Kabir"];
const LAST = ["Khan", "Al-Hashimi", "O'Brien", "Patel", "Rahman", "Sharma", "Haddad", "Nair"];
const TEAM_NAMES = ["Dark Patterns", "404 Club", "Captcha Kings", "Pop-Up Party", "The Spinners", "Ctrl Alt Defeat", "Loading Forever", "Accept All", "Null Pointers", "Cookie Monsters", "Infinite Scroll", "Undefined", "Rage Quit", "Blue Links", "Lorem Ipsum", "Modal Hell", "Dead Clicks", "Skeleton Crew", "Hamburger Menu", "Error 418"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
let n = 0;
const stamp = Date.now().toString(36);

function bot(role) {
  const ws = new WebSocket(URL);
  const b = { ws, role, view: null, waiting: new Map(), id: `bot-${role}-${String((n += 1)).padStart(4, "0")}-${stamp}` };
  b.act = (msg) =>
    new Promise((resolve) => {
      const op = Math.random().toString(36).slice(2, 12);
      b.waiting.set(op, resolve);
      ws.send(JSON.stringify({ ...msg, op }));
    });
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.t === "ping") ws.send('{"t":"pong"}');
    if (msg.t === "view" || msg.t === "who") b.view = msg.view;
    if (b.waiting.has(msg.op)) {
      b.waiting.get(msg.op)(msg);
      b.waiting.delete(msg.op);
    }
  });
  ws.on("error", () => {});
  b.ready = new Promise((resolve) =>
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", cid: b.id }));
      setTimeout(resolve, 50);
    })
  );
  return b;
}

const name = () => `${pick(FIRST)} ${pick(LAST)} ${Math.floor(Math.random() * 90 + 10)}`;
const bots = [];

for (let t = 0; t < TEAMS; t += 1) {
  const maker = bot("p");
  await maker.ready;
  const made = await maker.act({ t: "make", name: name(), team: TEAM_NAMES[t % TEAM_NAMES.length] + (t >= TEAM_NAMES.length ? ` ${t}` : "") });
  if (made.t !== "ok") console.log("make:", made.error);
  while (!maker.view?.team) await new Promise((r) => setTimeout(r, 20));
  bots.push(maker);
  for (let k = 0; k < 1 + (t % 3); k += 1) {
    const b = bot("p");
    await b.ready;
    const r = await b.act({ t: "join", name: name(), code: maker.view.team.code });
    if (r.t !== "ok") console.log("join:", r.error);
    bots.push(b);
  }
}
console.log(`${bots.length} participants in ${TEAMS} teams.`);

const judges = [];
for (let j = 0; j < JUDGES; j += 1) {
  const b = bot("j");
  await b.ready;
  judges.push(b);
}
const fans = [];
for (let f = 0; f < FANS; f += 1) {
  const b = bot("f");
  await b.ready;
  fans.push(b);
}

// Every second: judges rate the team on stage, fans and participants slap stickers.
setInterval(async () => {
  for (const j of judges) {
    if (!j.view?.you && j.view?.phase === "present" && PIN) {
      j.joining ??= j.act({ t: "judgeNew", pin: String(PIN), name: `Judge ${name()}` });
      continue;
    }
    const cur = j.view?.current;
    if (cur?.canRate && !cur.rating && Math.random() < 0.6) j.act({ t: "rate", team: cur.teamId, value: 1 + Math.floor(Math.random() * 6) });
  }
  for (const f of fans) {
    if (f.view && !f.view.you && f.view.stickers) {
      f.joining ??= f.act({ t: "audience", name: `Fan ${name()}`, ownTeam: null });
      continue;
    }
    const teams = f.view?.stickers?.teams ?? [];
    if (teams.length && Math.random() < 0.3) f.act({ t: "slap", team: pick(teams).id, kind: pick(KINDS), x: Math.floor(Math.random() * 1000), y: Math.floor(Math.random() * 1000) });
  }
  for (const b of bots) {
    const teams = b.view?.stickers?.teams ?? [];
    if (teams.length && Math.random() < 0.1) b.act({ t: "slap", team: pick(teams).id, kind: pick(KINDS), x: Math.floor(Math.random() * 1000), y: Math.floor(Math.random() * 1000) });
  }
}, 1000);
console.log(`${JUDGES} judges${PIN ? "" : " (no --pin: they won't sign in)"} and ${FANS} sticker fans waiting for presenting.`);
