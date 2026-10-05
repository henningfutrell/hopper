// The tenant track (issue #158, design.md "Users: one hopper, separate users"): the migrations of a
// user schema, with its own `schema_version`. Version 1 is the tenant tables exactly as they were at
// instance version 16 — where instance migration 17 moved owner's. A new user's schema is created at
// TENANT_BASE; a later change to a user's tables is appended to TENANT_MIGRATIONS and runs on every
// user schema as its store opens. Schema changes never drop a queue (persisted state is the user's).
import type { Db } from './db.ts';

type Migration = string | ((db: Db) => void);

export const TENANT_BASE_VERSION = 1;

/** The tables instance migration 17 moves to owner's user schema, as they are. */
export const TENANT_TABLES = ['jobs', 'lanes', 'decisions', 'events', 'webhooks', 'deliveries', 'questions'] as const;

/** A user schema at version 1: the tenant tables of instance version 16, column for column. */
const TENANT_BASE = `
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
    active INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    name TEXT UNIQUE,
    secret_env TEXT NOT NULL DEFAULT ''
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
  CREATE TABLE config_documents (name TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

/** Tenant migrations 2 on. */
const TENANT_MIGRATIONS: readonly Migration[] = [];

/** A user schema's version once migrated. */
export const TENANT_SCHEMA_VERSION = TENANT_BASE_VERSION + TENANT_MIGRATIONS.length;

/** `"name"`, quotes doubled: an identifier safe in SQL. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A user's schema: `u_<id>` beside the `public` instance schema, else `<instance schema>_u_<id>`. */
export const userSchemaName = (instanceSchema: string, userId: string): string =>
  (instanceSchema === 'public' ? `u_${userId}` : `${instanceSchema}_u_${userId}`);

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

/** Migrate the user schema `db` is connected to (its search_path) to the latest tenant version. */
export function migrateTenant(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = (): number => Number(db.get('SELECT version FROM schema_version')?.version ?? 0);
  const record = (v: number) => () => {
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', v);
  };
  if (version() === 0) step(db, TENANT_BASE, record(TENANT_BASE_VERSION));
  for (let v = version(); v < TENANT_SCHEMA_VERSION; v++) step(db, TENANT_MIGRATIONS[v - TENANT_BASE_VERSION]!, record(v + 1));
}
