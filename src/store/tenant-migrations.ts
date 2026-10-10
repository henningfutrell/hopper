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
import { noOpusLevel } from './migration-no-opus-level.ts';
import { yoloOption } from './migration-yolo.ts';
import { jobRepositoriesSetting } from './migration-job-repositories.ts';
import { jobsDirWorkTrees } from './migration-jobs-dir.ts';
import { herdrByName } from './migration-herdr-by-name.ts';
import { clientTargetsDialIn } from './migration-client-key.ts';
import { noGhSource } from './migration-no-gh-source.ts';
import { noAuthors } from './migration-no-authors.ts';
import { noCompletion } from './migration-no-completion.ts';
import { nameTheOnlyMachine } from './migration-name-the-machine.ts';
import { machineWorkTrees } from './migration-machine-work-trees.ts';
import { collapseFloodedLogins } from './migration-login-flood.ts';
import { raisedByBackfill } from './migration-raised-by.ts';
import { JOB_STREAM_TABLES } from './migration-job-stream.ts';
import { newerStore } from './migrations.ts';

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
  // 17: a claude-cli level or claude-plan source that names no machine names the one that can run claude, where one alone can (issue #442).
  nameTheOnlyMachine,
  // 18: a work tree is set per machine (issue #361): the paths that named no machine move onto machines and routing rules.
  machineWorkTrees,
  // 19: a webhook subscription's signing secret, sealed (src/secrets/sealer.ts), and when it last changed (issue #451).
  // A subscription from before keeps `secret_env` until one is stored. Columns only: the build before runs on it.
  `ALTER TABLE webhooks ADD COLUMN secret_sealed TEXT;
   ALTER TABLE webhooks ADD COLUMN secret_changed_at TEXT`,
  // 20: a question gets its raising machine where it can be known: its asked lane, its job's resumeOn, its job's pin (issue #485).
  raisedByBackfill,
  // 21: logins (issue #476): what the hopper keeps of a login a job or run waits on; never its URL or code.
  `CREATE TABLE logins (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT,
    question_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX logins_status ON logins (status);
  CREATE INDEX logins_job ON logins (job_id)`,
  // 22: the failure assessor (issue #509): a record per assessed failed job, and the problems shared causes are grouped into.
  `CREATE TABLE failures (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    at TEXT NOT NULL,
    pending_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX failures_job ON failures (job_id);
  CREATE INDEX failures_signature ON failures (signature, at);
  CREATE INDEX failures_at ON failures (at);
  CREATE INDEX failures_pending ON failures (pending_at);
  CREATE TABLE problems (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    signature TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX problems_status ON problems (status, signature)`,
  // 23: Needs a person (issue #516): a failed job automatic handling ended for, open until a person acts. A table
  // only: the build before runs on it.
  `CREATE TABLE handoffs (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX handoffs_job ON handoffs (job_id);
  CREATE INDEX handoffs_status ON handoffs (status, opened_at)`,
  // 24: Proposals (issue #537): a job's proposal, its versions and review trail in its body. A table only: the
  // build before runs on it.
  `CREATE TABLE proposals (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX proposals_job ON proposals (job_id);
  CREATE INDEX proposals_status ON proposals (status, created_at)`,
  // 25: Research reports (issue #543): the Research section's items, the same shape as the proposals'. A table only:
  // the build before runs on it.
  `CREATE TABLE research_reports (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX research_reports_job ON research_reports (job_id);
  CREATE INDEX research_reports_status ON research_reports (status, created_at)`,
  // 26: machine resources over time (issue #560): one machine sample per machine and time. A table only: the build
  // before runs on it.
  `CREATE TABLE machine_samples (
    seq BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    machine_id TEXT NOT NULL,
    cores DOUBLE PRECISION,
    cpu_busy DOUBLE PRECISION,
    load1 DOUBLE PRECISION,
    mem_total DOUBLE PRECISION,
    mem_available DOUBLE PRECISION,
    swap_total DOUBLE PRECISION,
    swap_used DOUBLE PRECISION,
    disk_free DOUBLE PRECISION,
    disk_total DOUBLE PRECISION,
    lanes_busy INTEGER NOT NULL,
    lanes_max INTEGER NOT NULL,
    UNIQUE (machine_id, at)
  );
  CREATE INDEX machine_samples_at ON machine_samples (at)`,
  // 27: the logins a device-flow polling loop flooded collapse into one per real prompt (issue #567).
  collapseFloodedLogins,
  // 28: The vault (issue #558): each secret's sealed value (`sealed`, never read into its metadata) beside its metadata.
  // A table only: the build before runs on it.
  `CREATE TABLE vault_secrets (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    sealed TEXT NOT NULL,
    body TEXT NOT NULL
  )`,
  // 29: Templates (issue #558): an image and the vault secrets its boxes may ask for, with its last approval, in its
  // body. A table only: the build before runs on it.
  `CREATE TABLE templates (
    seq BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  )`,
  // 30: done is always a pull request ready for review (issue #579): the GitHub sources' `completion` option goes.
  // The build before reads a source with none as its old default.
  noCompletion,
  // 31: Vault backends (issue #585): a vault secret kept in a backend has no sealed value, only its reference in its
  // body. The build before reads a missing value as one it cannot open, and refuses to deliver it.
  'ALTER TABLE vault_secrets ALTER COLUMN sealed DROP NOT NULL',
  // 32: The job stream (issue #613): each job's stream events and the watches its requests are waited on by.
  JOB_STREAM_TABLES,
  // 33: the default ladder goes straight to the frontier level (issue #632): the old built-in opus level goes. The build
  // before runs on the one level left.
  noOpusLevel,
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
  const from = version();
  if (from > TENANT_SCHEMA_VERSION) throw new Error(newerStore(`a user schema is at version ${from}`, TENANT_SCHEMA_VERSION));
  if (from === 0) step(db, TENANT_BASE, record(TENANT_BASE_VERSION));
  for (let v = version(); v < to; v++) step(db, TENANT_MIGRATIONS[v - TENANT_BASE_VERSION]!, record(v + 1));
}
