import type { DatabaseSync } from 'node:sqlite';
import { migrateRouterNames } from './migrate-router.ts';

// Schema changes append a migration here; they never drop a queue (persisted state is the
// user's). `PRAGMA user_version` is the applied-migration count. A migration is SQL, or a
// function for a rewrite SQL cannot say plainly (JSON bodies); both run in one transaction.
const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
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
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const m = MIGRATIONS[v]!;
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
