// The event's whole state lives in one SQLite file. Every change is written in a transaction
// before anyone is told about it, so stopping the server at any moment (Ctrl+C, a crash, the
// battery) and starting it again picks up exactly where it was. Nothing is replayed: starting up
// is opening the file.
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('made','pool','host')),
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  removed_at INTEGER,
  dealt_at INTEGER,
  swap_until INTEGER,
  swapped_at INTEGER,
  link_url TEXT,
  link_kind TEXT CHECK (link_kind IN ('url','own-laptop')),
  link_at INTEGER,
  link_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name ON teams(name_key) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('participant','judge','audience')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  cert_name TEXT,
  team_id INTEGER REFERENCES teams(id),
  pool_since INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
-- Nobody shares a name inside a team, or among the people of one role without a team, so
-- reclaiming by name can never be ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS people_in_team ON people(team_id, name_key) WHERE removed_at IS NULL AND team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_loose ON people(role, name_key) WHERE removed_at IS NULL AND team_id IS NULL;

CREATE TABLE IF NOT EXISTS devices (
  client_id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  bound_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_cards (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  slot INTEGER NOT NULL CHECK (slot IN (0,1)),
  feature TEXT NOT NULL,
  dealt_at INTEGER NOT NULL,
  replaced TEXT,
  PRIMARY KEY (team_id, slot)
);

CREATE TABLE IF NOT EXISTS demos (
  slot INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL UNIQUE REFERENCES teams(id),
  started_at INTEGER,
  ends_at INTEGER,
  ended_at INTEGER,
  skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
  judge_id INTEGER NOT NULL REFERENCES people(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 6),
  first_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (judge_id, team_id)
);

CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  kind TEXT NOT NULL,
  quest INTEGER NOT NULL CHECK (quest IN (0,1)),
  x INTEGER NOT NULL CHECK (x BETWEEN 0 AND 1000),
  y INTEGER NOT NULL CHECK (y BETWEEN 0 AND 1000),
  op TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  moved_at INTEGER,
  removed_at INTEGER,
  UNIQUE (person_id, op)
);
CREATE INDEX IF NOT EXISTS stickers_team ON stickers(team_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, mode TEXT, phase TEXT, pid INTEGER);
`;

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    const err = new Error("This Node has no built-in SQLite. Update Node to 22.13 or newer.");
    err.code = "NO_SQLITE";
    throw err;
  }
}

// ---------- One running copy per database ----------
// Two servers on one file would each think they're the event. The lock file holds the pid; a
// lock left by a server that died is taken over.
export function takeLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code === "EPERM";
        }
      }
      if (alive) {
        const busy = new Error(`USER UNFRIENDLY is already running (process ${pid}). Stop it first.`);
        busy.code = "ALREADY_RUNNING";
        throw busy;
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error("Couldn't take the lock");
}

// ---------- Starting over without losing anything ----------
// Copies the database into archive/ and removes it, so the next start is a new event.
export async function archiveDatabase(file, archiveDir, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = await loadSqlite();
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = path.join(archiveDir, `unfriendly-${stamp}.db`);
  const db = new DatabaseSync(file);
  db.prepare("VACUUM INTO ?").run(target);
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
  return target;
}

export async function openStore(file, { now = Date.now, judgePin = null } = {}) {
  const { DatabaseSync } = await loadSqlite();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  // Added after the first version: the team a sticker-only person says they're in.
  if (!db.prepare("PRAGMA table_info(people)").all().some((c) => c.name === "own_team_id")) db.exec("ALTER TABLE people ADD COLUMN own_team_id INTEGER");
  // Added on the day: the one member who holds the team's swap.
  if (!db.prepare("PRAGMA table_info(teams)").all().some((c) => c.name === "swapper_id")) db.exec("ALTER TABLE teams ADD COLUMN swapper_id INTEGER");

  const statements = new Map();
  const stmt = (sql) => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const run = (sql, ...params) => stmt(sql).run(...params);
  const get = (sql, ...params) => stmt(sql).get(...params);
  const all = (sql, ...params) => stmt(sql).all(...params);

  let depth = 0;
  // One change, all or nothing. It's on disk when this returns.
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    } finally {
      depth = 0;
    }
  }

  function getMeta(key, fallback = null) {
    const row = get("SELECT value FROM meta WHERE key = ?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  function setMeta(key, value) {
    if (value === undefined || value === null) run("DELETE FROM meta WHERE key = ?", key);
    else run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
  function audit(actor, action, detail) {
    run("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", now(), actor, action, detail === undefined ? null : JSON.stringify(detail));
  }

  // A new database: the event gets an id and starts in the join phase.
  tx(() => {
    const version = getMeta("schema_version");
    if (version === null) {
      setMeta("schema_version", SCHEMA_VERSION);
      setMeta("event_id", `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      setMeta("created_at", now());
      setMeta("phase", "join");
      setMeta("phase_at", now());
    } else if (version > SCHEMA_VERSION) {
      throw new Error(`This database is from a newer version of the app (schema ${version}).`);
    }
    // The judges' PIN: from .env (UU_JUDGE_PIN) if set, so it can be shared before the event,
    // otherwise four random digits kept with the event.
    if (judgePin && getMeta("judge_pin") !== judgePin) setMeta("judge_pin", judgePin);
    if (!getMeta("judge_pin")) setMeta("judge_pin", String(1000 + Math.floor(Math.random() * 9000)));
  });

  // Everything about teams and people, small enough to read whole after every change.
  function load() {
    const meta = Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, JSON.parse(r.value)]));
    const teams = all("SELECT * FROM teams ORDER BY id");
    const cards = all("SELECT * FROM team_cards ORDER BY team_id, slot");
    const people = all("SELECT * FROM people ORDER BY id");
    const demos = all("SELECT * FROM demos ORDER BY slot");
    const ratings = all("SELECT * FROM ratings");
    const byTeam = new Map();
    for (const c of cards) {
      if (!byTeam.has(c.team_id)) byTeam.set(c.team_id, []);
      byTeam.get(c.team_id)[c.slot] = c;
    }
    return {
      meta,
      teams: teams.map((t) => ({ ...t, cards: (byTeam.get(t.id) ?? []).map((c) => c.feature), replaced: (byTeam.get(t.id) ?? []).map((c) => c.replaced) })),
      people,
      demos,
      ratings,
    };
  }

  function backup(dir, label) {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(now());
    const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    const target = path.join(dir, `${stamp}-${String(label).replace(/[^a-z0-9-]/gi, "")}.db`);
    fs.rmSync(target, { force: true });
    db.prepare("VACUUM INTO ?").run(target);
    // Keep the newest 40.
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(40)) fs.rmSync(path.join(dir, old.f), { force: true });
    return target;
  }

  return {
    db,
    tx,
    run,
    get,
    all,
    getMeta,
    setMeta,
    audit,
    load,
    backup,
    close() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Closing anyway.
      }
      db.close();
    },
  };
}
