import type { Db } from './db.ts';
import { migrateRouterNames } from './migrate-router.ts';

// Schema changes never drop a queue (persisted state is the user's). A migration is SQL, or a
// function for a rewrite SQL cannot say plainly (JSON bodies); each runs in one transaction.
//
// One schema version for both databases (design.md "Database"): the applied-migration count —
// SQLite's `PRAGMA user_version`, Postgres's `schema_version` table. SQLite's first six are its
// history (SQLITE_HISTORY); a Postgres store starts at the shape they end at (POSTGRES_BASE, version
// 6). A new migration is appended to SHARED, in SQL both databases mean the same way.
type Migration = string | ((db: Db) => void);

const SQLITE_HISTORY: readonly Migration[] = [
  `
  CREATE TABLE jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL            -- the Job as JSON (spec, advice, result inside)
  );
  CREATE INDEX jobs_status ON jobs (status);
  CREATE TABLE lanes (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (machine_id, number)
  );
  CREATE TABLE decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    job_id TEXT, lane_id TEXT, machine_id TEXT, decision_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX events_type ON events (type, seq);
  CREATE TABLE webhooks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_attempt_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE questions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL            -- the Question as JSON (attempts inside)
  );
  CREATE INDEX questions_status ON questions (status);
  CREATE INDEX questions_job ON questions (job_id);
  ALTER TABLE events ADD COLUMN question_id TEXT;
  `,
  `
  ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE jobs ADD COLUMN source_key TEXT;
  CREATE UNIQUE INDEX jobs_source_key ON jobs (source_key);
  ALTER TABLE webhooks ADD COLUMN name TEXT;
  UPDATE webhooks SET name = 'legacy-' || id;
  CREATE UNIQUE INDEX webhooks_name ON webhooks (name);
  `,
  // 4: Jev → router names in jobs, decisions and settings (phase 5).
  migrateRouterNames,
  // 5: a source key may have many jobs (a re-run); the newest one is the key's job.
  `
  DROP INDEX jobs_source_key;
  CREATE INDEX jobs_source_key ON jobs (source_key);
  `,
  // 6: UI sessions outlive a daemon restart. Only the token's SHA-256 is kept (the token is a secret).
  `
  CREATE TABLE ui_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  `,
];

/** SQLITE_HISTORY's end state, in Postgres: version 6. */
const POSTGRES_BASE = `
  CREATE TABLE jobs (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL,
    source_key TEXT
  );
  CREATE INDEX jobs_status ON jobs (status);
  CREATE INDEX jobs_source_key ON jobs (source_key);
  CREATE TABLE lanes (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (machine_id, number)
  );
  CREATE TABLE decisions (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE events (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    job_id TEXT, lane_id TEXT, machine_id TEXT, decision_id TEXT,
    data TEXT NOT NULL,
    question_id TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX events_type ON events (type, seq);
  CREATE TABLE webhooks (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    name TEXT UNIQUE
  );
  CREATE TABLE deliveries (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_attempt_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE questions (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX questions_status ON questions (status);
  CREATE INDEX questions_job ON questions (job_id);
  CREATE TABLE ui_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
`;

/** Migrations 7 on, for both databases. */
const SHARED: readonly Migration[] = [];

/** The schema version a store is at once migrated. */
export const SCHEMA_VERSION = SQLITE_HISTORY.length + SHARED.length;

function step(db: Db, m: Migration, begin: string, record: () => void): void {
  db.exec(begin);
  try {
    if (typeof m === 'string') db.exec(m);
    else m(db);
    record();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrateSqlite(db: Db): void {
  const all = [...SQLITE_HISTORY, ...SHARED];
  const at = (db.get('PRAGMA user_version') as { user_version: number }).user_version;
  for (let v = at; v < all.length; v++) step(db, all[v]!, 'BEGIN IMMEDIATE', () => db.exec(`PRAGMA user_version = ${v + 1}`));
}

function migratePostgres(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = (): number => Number(db.get('SELECT version FROM schema_version')?.version ?? 0);
  const record = (v: number) => () => {
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', v);
  };
  if (version() === 0) step(db, POSTGRES_BASE, 'BEGIN', record(SQLITE_HISTORY.length));
  for (let v = version(); v < SCHEMA_VERSION; v++) step(db, SHARED[v - SQLITE_HISTORY.length]!, 'BEGIN', record(v + 1));
}

export function migrate(db: Db): void {
  if (db.dialect === 'sqlite') migrateSqlite(db);
  else migratePostgres(db);
}
