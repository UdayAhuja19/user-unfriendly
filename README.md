# USER UNFRIENDLY · event app

The app that runs **USER UNFRIENDLY** (GDG on Campus UOBD × Computing Club, Tue 27 Oct 2026, 16:00–18:00, Room 0411): teams build a website with a great UI and the worst possible UX.

One laptop runs everything. The **host panel** stays on the laptop's screen, the **big screen** goes on the projector, and everyone joins on their **phone** by scanning a QR code. It covers the whole event: teams forming, dealing a feature to ruin to each team (one random member per team holds its one swap), adding late teams on the spot, the build countdown, collecting site links, presenting with judges' ratings and stickers, and revealing the winners. At the end it exports the certificate lists.

**Running the event?** Read the [operator's manual (PDF)](docs/operator-manual.pdf). It explains every step, with screenshots, what to say to the room, and what to do if something goes wrong.

---

## Set up a laptop (once, about 10 minutes)

These steps are for a Mac.

1. **Node.js 22.13 or newer.** Check with `node --version`. If it's missing or older, install the LTS version from [nodejs.org](https://nodejs.org).
2. **Homebrew** (for the next step), if you don't have it: see [brew.sh](https://brew.sh).
3. **cloudflared**, which lets phones on eduroam reach the laptop:
   ```bash
   brew install cloudflared
   ```
4. **Get the app and install it:**
   ```bash
   cd ~/Desktop
   git clone https://github.com/UdayAhuja19/user-unfriendly.git
   cd user-unfriendly
   npm install
   ```
5. **Check it works:**
   ```bash
   npm test
   ```
   Every test should pass.

**The judges' PIN is 6767.** To use another one, put it in front of the first start: `UU_JUDGE_PIN=482193 npm run unfriendly -- --fresh` (or in `.env`). The host panel shows it while you hold **HOLD TO SHOW THE PIN**.

## On the day

```bash
cd ~/Desktop/user-unfriendly
npm run unfriendly -- --fresh
```

After that, to start it again at any point, **double-click `Start USER UNFRIENDLY.command`** in the app's folder (or run `npm run unfriendly`). It remembers how it was last started.

Type `FRESH` when it asks. This starts a new, empty event; any test data is archived, not deleted. To set the judges' PIN at the same time:

```bash
UU_JUDGE_PIN=482193 npm run unfriendly -- --fresh
```

Phones join over the **same Wi-Fi** as the laptop (LAN) unless you start it with `--tunnel`. When Terminal shows `Phones on this Wi-Fi join at: http://…:3300` (click **Allow** if macOS asks about incoming connections):

- **Big screen:** open http://localhost:3301 in Chrome, drag the window to the projector and make it full screen (control ⌘ F).
- **Host panel:** open http://localhost:3301/host on the laptop's own screen.

**If it crashes, it restarts by itself** within 2 seconds and carries on exactly where it left off; nothing is lost. **If you stop it** (Ctrl+C, Terminal closed, flat battery), start it again with plain `npm run unfriendly` and **never `--fresh`**.

The manual has everything else.

## Commands

| Command | What it does |
|---|---|
| `npm run unfriendly` | Start, or carry on with, the event, the way it was started last time (LAN the first time). |
| `npm run unfriendly -- --tunnel` | Phones join through a free Cloudflare tunnel instead, for a Wi-Fi that keeps devices apart. Remembered for later starts. |
| `npm run unfriendly -- --fresh` | Archive the current event and start a new one (asks you to type FRESH). |
| `npm run unfriendly -- --lan` | Back to LAN: phones on the same Wi-Fi join the laptop directly. The link stays the same after a restart. |
| `npm run unfriendly -- --offline` | Host panel only, no phones. Used to nudge the build clock while the app is otherwise off. |
| `npm run unfriendly -- --clock` | Also open the offline build clock, which counts down without the app. |
| `npm run unfriendly -- --preview` | A separate practice copy on ports 3310/3311 with its own data. It never touches the real event. |
| `npm run unfriendly -- --local` | Nothing leaves the laptop. Open http://localhost:3300/?p=1, ?p=2 … as pretend phones. |
| `npm run bots -- 12 ws://127.0.0.1:3310/ws --judges 6 --fans 20 --pin <PIN>` | Fill a `--preview` event with pretend teams, judges and sticker fans for a rehearsal. |
| `npm test` | Run the tests. |

Extra options: `--scale 0.1` makes every duration a tenth (for drills), `--db <file>`, `--ports <phone>,<screen>`, `--no-caffeinate`.

## How it works

- **Two ports, one program.** The phone port (3300) is the only one exposed, through the tunnel. The big screen, the host panel and the certificate downloads are on port 3301, which answers only on the laptop itself.
- **Auto-restart.** `npm run unfriendly` runs `server/unfriendly/run.js`, which restarts the app 2 s after any crash. A restart never repeats `--fresh`; Ctrl+C stops everything; problems only a person can fix (another copy running, a busy port) aren't retried; after 6 crashes in a minute it stops. `--no-restart` turns it off.
- **The database is the state.** Everything is saved to `data/unfriendly/unfriendly.db` (SQLite, built into Node) the moment it happens, before anyone is told. A restart, even after a crash, carries on exactly. Nothing changes phase on a timer: the host presses a button for every step. Backups go to `data/unfriendly/backups/`.
- **The build clock never stops.** The big screen counts down from the end time even with the app stopped. A self-contained clock page is also written to `data/unfriendly/clock/`, and the display is kept awake until 15 minutes after pencils down.
- **Phones get back in by themselves.** A phone remembers who it is. After a restart (which gives a new tunnel link) people rescan the QR, type their team code and tap their name. Judges enter the PIN and tap their name.
- **Results.** The main award, User unfriendliest, comes from the judges' ratings: each judge's ratings are normalised against their own average, then the top and bottom 10% are trimmed. The four side quests come from sticker shares, with each team winning at most one title. One click downloads `certificates.zip` with `winners.csv`, `participants.csv`, `judges.csv` and `everything.json`. After the last award, one more press shows an end screen that can stay up.

## Layout

```
server/unfriendly/   the server: index.js (start-up and flags), server.js (ports, sockets), store.js (SQLite),
                     event.js (rules and views), commands.js and show.js (every action), results.js, deck.js (features),
                     clock.js (offline clock), qr.js, net.js
server/party/tunnel.js   starts the Cloudflare quick tunnel
unfriendly/          the pages: phone.html (participants and stickers), judge.html, screen.html (big screen), host.html,
                     with js/, css/ and brand/ (the event's brand sheet: colours, fonts, parts)
public/js/shared/names.js   the blocklist for team names
scripts/unfriendly-bots.js  pretend phones for rehearsals
test/                tests, including restarts after kill -9
docs/operator-manual.pdf    the guide for whoever runs the laptop
```

Made by GDG on Campus UOBD.
