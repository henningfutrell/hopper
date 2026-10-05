<<<<<<< HEAD
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
=======
import { isMap, isScalar, parseDocument } from 'yaml';
>>>>>>> d836e15 (feat: router is a role, Jev a model — router plugin gate-router (#76))
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
  // 9: one-time UI login codes live in the store (minted by `hopper login-code`), not in a file.
  // Only the code's SHA-256 is kept.
  `
  CREATE TABLE IF NOT EXISTS login_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  `,
  // 10: no secret in clear (issue #53): a subscription's secret is stored sealed. The table is a
  // projection of webhooks.yaml, written sealed at every load, so a clear one left from before goes.
  `
  UPDATE webhooks SET secret = '' WHERE secret NOT LIKE 'sealed:%';
  `,
  // 11: the hopper keeps no secret (issue #56): a subscription names the variable the runtime gives its
  // secret in. The sealed secrets go with their column; the next load of webhooks.yaml fills secret_env.
  `
  ALTER TABLE webhooks ADD COLUMN secret_env TEXT NOT NULL DEFAULT '';
  ALTER TABLE webhooks DROP COLUMN secret;
  `,
  // 12: the rename to hopper (issue #112) renames the hopper's own herdr session, and the default
  // `session` with it. plugins.yaml keeps its meaning: see renameHerdrSession.
  renameHerdrSession,
  // 13: the router is a role, Jev is a model (issue #76). The router plugin `jev-router` is
  // `gate-router`, and its options say which model answers a gate.
  renameGateRouter,
];

/**
 * An ssh-attached machine that named no session ran its jobs in `job-hopper`, the session its own unit
 * there still runs: it is named, until that machine is attached again under the new name. A herdr-claude
 * instance that named `job-hopper` named the local unit's session, which is now `hopper`, the default:
 * the option goes. Comments and everything else in the document are kept.
 */
function renameHerdrSession(db: Db): void {
  const text = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'")?.text;
  if (typeof text !== 'string') return;
  const doc = parseDocument(text);
  let changed = false;
  const items = (key: string): YAMLMap[] => {
    const list = doc.get(key);
    return isSeq(list) ? list.items.filter(isMap) : [];
  };
  for (const m of items('attachedMachines')) {
    if (m.has('ssh') && !m.has('session')) { m.set('session', 'job-hopper'); changed = true; }
  }
  for (const e of items('executors')) {
    const options = e.get('options');
    if (e.get('plugin') !== 'herdr-claude' || !isMap(options) || options.get('session') !== 'job-hopper') continue;
    options.delete('session');
    if (options.items.length === 0) e.delete('options');
    changed = true;
  }
  if (changed) db.run("UPDATE config_documents SET text = ?, updated_at = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }), new Date().toISOString());
}

/** Options of the router plugin `jev-router`, under their `gate-router` names. */
const GATE_ROUTER_OPTIONS: Readonly<Record<string, string>> = { jevSrc: 'grokBotJevSrc', model: 'claudeModel', typesafeGates: 'jevGates' };

/**
 * plugins.yaml naming the router plugin `jev-router` names `gate-router`, with the options renamed; an
 * instance named `jev` or `jev-router` takes the new plugin's name. Comments and other sections stay. A
 * document that does not parse is left for the owner (the daemon reports it as before).
 */
function renameGateRouter(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  if (doc.errors.length > 0) return;
  const router = doc.get('router');
  if (!isMap(router) || router.get('plugin') !== 'jev-router') return;
  router.set('plugin', 'gate-router');
  if (router.get('name') === 'jev' || router.get('name') === 'jev-router') router.set('name', 'gate-router');
  const options = router.get('options');
  if (isMap(options)) {
    for (const pair of options.items) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key === 'string' && key in GATE_ROUTER_OPTIONS) pair.key = GATE_ROUTER_OPTIONS[key];
    }
  }
  db.run("UPDATE config_documents SET text = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }));
}

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
