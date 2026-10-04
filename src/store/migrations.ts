import type { Db } from './db.ts';

// Schema changes never drop a queue (persisted state is the user's). A migration is SQL, or a
// function for a rewrite SQL cannot say plainly (JSON bodies); each runs in one transaction.
//
// The schema version is the `schema_version` table (design.md "Database"). A new store is created at
// BASE, version 6; every migration after it is appended to MIGRATIONS.
type Migration = string | ((db: Db) => void);

const BASE_VERSION = 6;

/** The schema a new store starts at: version 6 (the first six versions were SQLite's, before Postgres). */
const BASE = `
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

/** Migrations 7 on. */
const MIGRATIONS: readonly Migration[] = [
  // 7: a session belongs to someone (issue #39): the role it acts with and the identity behind it.
  // Sessions from before were all made from the login code: admin, provider local.
  `
  ALTER TABLE ui_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE ui_sessions ADD COLUMN identity TEXT NOT NULL DEFAULT '{"provider":"local","subject":"local","name":"login code","groups":[]}';
  `,
  // 8: config documents (plugins.yaml, webhooks.yaml, rules.md, auth.yaml) live in the store, not in files.
  `
  CREATE TABLE IF NOT EXISTS config_documents (name TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  // 9: one-time UI login codes live in the store (minted by `job-hopper login-code`), not in a file.
  // Only the code's SHA-256 is kept.
  `
  CREATE TABLE IF NOT EXISTS login_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  `,
];

/** The schema version a store is at once migrated. */
export const SCHEMA_VERSION = BASE_VERSION + MIGRATIONS.length;

function step(db: Db, m: Migration, record: () => void): void {
  db.exec('BEGIN');
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

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = (): number => Number(db.get('SELECT version FROM schema_version')?.version ?? 0);
  const record = (v: number) => () => {
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', v);
  };
  if (version() === 0) step(db, BASE, record(BASE_VERSION));
  for (let v = version(); v < SCHEMA_VERSION; v++) step(db, MIGRATIONS[v - BASE_VERSION]!, record(v + 1));
}
