// The tenant track (issue #158, design.md "Users: one hopper, separate users"): the migrations of a
// user schema, with its own `schema_version`. Version 1 is the tenant tables exactly as they were at
// instance version 16 — where instance migration 17 moved owner's. A new user's schema is created at
// TENANT_BASE; a later change to a user's tables is appended to TENANT_MIGRATIONS and runs on every
// user schema as its store opens. Schema changes never drop a queue (persisted state is the user's).
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Db } from './db.ts';
import { documentsToRecords } from './migration-config.ts';
import { gateRouterSettingsAsConcepts } from './migration-gate-router-settings.ts';
import { connectedAccounts } from './migration-connected-accounts.ts';
import { levelsNamedAsLevels } from './migration-level-names.ts';
import { yoloOption } from './migration-yolo.ts';
import { jobRepositoriesSetting } from './migration-job-repositories.ts';
import { jobsDirWorkTrees } from './migration-jobs-dir.ts';
import { herdrByName } from './migration-herdr-by-name.ts';
import { clientTargetsDialIn } from './migration-client-key.ts';
import { noGhSource } from './migration-no-gh-source.ts';
import { noAuthors } from './migration-no-authors.ts';

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

/**
 * Tenant migration 2 (issue #163): a turn without a marker is a status note and the agent is nudged,
 * never asked. Every herdr-claude executor's option `idleQuestionMs` is `idleNudgeMs`, value kept.
 * Comments and everything else in the document stay; a document that does not parse is left for the
 * owner (the daemon reports it as before).
 */
function renameIdleQuestionMs(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  const executors = doc.get('executors');
  if (doc.errors.length > 0 || !isSeq(executors)) return;
  let changed = false;
  for (const e of executors.items) {
    const options = isMap(e) && e.get('plugin') === 'herdr-claude' ? e.get('options') : undefined;
    if (!isMap(options)) continue;
    for (const pair of options.items) {
      if (isScalar(pair.key) && pair.key.value === 'idleQuestionMs') { pair.key.value = 'idleNudgeMs'; changed = true; }
    }
  }
  if (changed) db.run("UPDATE config_documents SET text = ?, updated_at = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }), new Date().toISOString());
}

/** The plugins that run on a machine, by plugins.yaml section, as they were before issue #174: none named ran here. */
const RAN_HERE = { escalationLevels: 'claude-cli', usageSources: 'claude-plan' } as const;

/**
 * Tenant migration 3 (issue #174): a part that runs on a machine names it; this machine is no default.
 * A claude-cli escalation level or a claude-plan usage source that named no `machine` ran here: it
 * names this machine — the `local` instance of `machines:`, or the built-in `local` where the section
 * is absent. Where there is none (the container) nothing is named, and the owner picks one. Comments
 * and everything else in the document stay; a document that does not parse is left for the owner.
 */
function nameTheLocalMachine(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  if (doc.errors.length > 0) return;
  const machines = doc.get('machines');
  const local = !doc.has('machines') ? 'local'
    : isSeq(machines) ? machines.items.find((m) => isMap(m) && m.get('plugin') === 'local') : undefined;
  const name = isMap(local) ? local.get('name') : local;
  if (typeof name !== 'string' || !name) return;
  let changed = false;
  for (const [section, plugin] of Object.entries(RAN_HERE)) {
    const list = doc.get(section);
    if (!isSeq(list)) continue;
    for (const item of list.items) {
      if (!isMap(item) || item.get('plugin') !== plugin) continue;
      const options = item.get('options');
      if (isMap(options) && options.has('machine')) continue;
      if (isMap(options)) options.set('machine', name);
      else item.set('options', doc.createNode({ machine: name }, { flow: true }));
      changed = true;
    }
  }
  if (changed) db.run("UPDATE config_documents SET text = ?, updated_at = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }), new Date().toISOString());
}

/** Tenant migrations 2 on. */
const TENANT_MIGRATIONS: readonly Migration[] = [
  // 2: herdr-claude's idleQuestionMs is idleNudgeMs (issue #163).
  renameIdleQuestionMs,
  // 3: a claude-cli level or claude-plan usage source names its machine (issue #174).
  nameTheLocalMachine,
  // 4: no config files and no YAML (issue #198): plugins.yaml and rules.md become the config records
  // `plugins` and `rules`.
  (db) => documentsToRecords(db, { 'plugins.yaml': 'plugins', 'rules.md': 'rules' }),
  // 5: an escalation level is named as a level, never after a model (issue #209).
  levelsNamedAsLevels,
  // 6: the gate router's settings are concepts, not leftovers (issue #217).
  gateRouterSettingsAsConcepts,
  // 7: there is no router mode (issue #211): the router's advice is always applied.
  "DELETE FROM settings WHERE key = 'routerMode'",
  // 8: a user's connected accounts (issue #214), and a job source for each in the plugins config.
  connectedAccounts,
  // 9: yolo is a herdr-claude executor's own option, out of its args (issue #267).
  yoloOption,
  // 10: a connected account's job repositories are the user's setting, out of its source's options (issue #321).
  jobRepositoriesSetting,
  // 11: a work tree stored as the home is the jobs directory (issue #314).
  jobsDirWorkTrees,
  // 12: herdr is called by name on an ssh machine: its `herdrBin` goes (issue #311).
  herdrByName,
  // 13: a client target dials in with its machine key (issue #308): one holding a token variable leaves `machines`.
  clientTargetsDialIn,
  // 14: the gh CLI job source is gone (issue #359): its instances leave `jobSources`, its repos become the job repositories.
  noGhSource,
  // 15: the usage history (issue #385): every usage reading kept as a usage sample, once per source, machine, usage window and time.
  `CREATE TABLE usage_samples (
    seq BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    machine_id TEXT NOT NULL DEFAULT '',
    usage_window TEXT NOT NULL DEFAULT '',
    used DOUBLE PRECISION NOT NULL,
    limit_value DOUBLE PRECISION NOT NULL,
    unit TEXT NOT NULL,
    resets_at TIMESTAMPTZ,
    informational BOOLEAN NOT NULL DEFAULT FALSE,
    account TEXT,
    UNIQUE (source, machine_id, usage_window, at)
  );
  CREATE INDEX usage_samples_at ON usage_samples (at)`,
  // 16: intake is by label and assignee (issue #387): the GitHub sources' `authors` option goes.
  noAuthors,
];

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

/** Migrate the user schema `db` is connected to (its search_path) up to `to` (default: the latest; a lower one only for a migration's own test). */
export function migrateTenant(db: Db, to = TENANT_SCHEMA_VERSION): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = (): number => Number(db.get('SELECT version FROM schema_version')?.version ?? 0);
  const record = (v: number) => () => {
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', v);
  };
  if (version() === 0) step(db, TENANT_BASE, record(TENANT_BASE_VERSION));
  for (let v = version(); v < to; v++) step(db, TENANT_MIGRATIONS[v - TENANT_BASE_VERSION]!, record(v + 1));
}
