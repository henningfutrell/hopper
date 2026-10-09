import { githubRealmsThroughTheApp } from './migration-device-realms.ts';
import { randomUUID } from 'node:crypto';
import { isMap, isScalar, isSeq, parse, parseDocument, type YAMLMap } from 'yaml';
import type { Db } from './db.ts';
import { passwordAccountsTable } from './migration-accounts.ts';
import { noPasswordRealm } from './migration-no-password-realm.ts';
import { documentsToRecords } from './migration-config.ts';
import { signInRealms } from './migration-realms.ts';
import { usersAndOwner } from './migration-users.ts';
import { ownerToAdmin } from './migration-admin.ts';
import { noBootstrapUser } from './migration-no-bootstrap.ts';
import { sessionsRenew, sessionsTheBuildBeforeReads } from './migration-session-lifetime.ts';
import { attachedMachinesToInstances } from './migration-attached-machines.ts';

// Schema changes never drop a queue (persisted state is the user's). A migration is SQL, or a
// function for a rewrite SQL cannot say plainly (JSON bodies); each runs in one transaction.
//
// The schema version is the `schema_version` table (design.md "Database"). A new store is created at
// BASE, version 6; every migration after it is appended to MIGRATIONS. This is the instance track:
// since migration 17 (issue #158) a user's tables live in a user schema with a track of its own
// (tenant-migrations.ts); a change to them goes there.
// A function migration is given the version the store had when this run began: 0 for a new store.
type Migration = string | ((db: Db, from: number) => void);

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
  // 9: one-time UI login codes live in the store, not in a file.
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
  // 14: webhook subscriptions live in the table and nothing else (issue #78).
  webhooksDocumentToRows,
  // 15: attached machines are machine-source instances (issue #74): plugins.yaml `machines:` becomes
  // the list of them, and `attachedMachines:` goes.
  attachedMachinesToInstances,
  // 16: the question path is escalation levels (issue #134), in plugins.yaml and in the stored trails.
  (db) => { escalationLevelsSection(db); levelAttempts(db); },
  // 17: several users (issue #158). The instance keeps users, identity links, UI sessions, login codes,
  // auth.yaml and its own settings; everything else becomes the first user's, `owner`.
  usersAndOwner,
  // 18: sign-in is realms (issue #185): auth.yaml's password and providers become `realms`, and stored
  // sessions and identity links name their realm.
  signInRealms,
  // 19: no config files and no YAML (issue #198): auth.yaml becomes the config record `sign-in`.
  (db) => documentsToRecords(db, { 'auth.yaml': 'sign-in' }),
  // 20: the password accounts are a table (issue #200): `password_accounts` takes each password realm's
  // `users` out of `sign-in`; a hopper with no `sign-in` gets the realm `password`, no accounts yet.
  passwordAccountsTable,
  // 21: the built-in user `owner` becomes the default admin account, `admin` (issue #220): its schema,
  // links, sessions and codes move to it; sessions and login codes name their user, with no default.
  ownerToAdmin,
  // 22: no password user realm (issue #237): password realms, `password_accounts` and their identity
  // links go; a sign-in config left with no way in turns the login code on.
  noPasswordRealm,
  // 23: a github realm signs in through the hopper's GitHub App by the device flow (issue #214): its own
  // OAuth app's settings and client secret leave the `sign-in` record, and a hopper without one gets one.
  githubRealmsThroughTheApp,
  // 24: no bootstrap user (issue #238): a new store ends with no user; an install from before keeps admin,
  // and no sign-in is linked to it.
  noBootstrapUser,
  // 25: one-time join codes (issue #308): a machine's, as a login code is a browser's. Only the code's SHA-256 is kept.
  `
  CREATE TABLE IF NOT EXISTS join_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, user_id TEXT NOT NULL);
  `,
  // 26: the update channels are dev, beta and stable (issue #423). main and release, the two stable channels
  // from before, are stable; dev and beta stay.
  "UPDATE settings SET value = 'stable' WHERE key = 'updateChannel' AND value IN ('main', 'release');",
  // 27: sessions renew (issue #439): no fixed expiry; when a session started, was last used and its gateway
  // token last checked out, and the sign-in config's session lengths decide when it ends.
  sessionsRenew,
  // 28: the UI sessions table as the build before 27 reads and writes it, beside this build's (issue #527): 27 dropped
  // `expires_at`, and that build, rolled back to on a migrated store, failed every session it made or looked up.
  sessionsTheBuildBeforeReads,
  // 29: access (issue #559): the access models, the tuples the hopper pushes to OpenFGA (a revoked one kept with who
  // and when), what it keeps of OpenFGA (its store and the model pushed there) and every mint decision. New tables
  // only: the build before never reads them.
  `
  CREATE TABLE IF NOT EXISTS access_models (seq BIGSERIAL PRIMARY KEY, dsl TEXT NOT NULL, written_by TEXT NOT NULL, written_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS access_tuples (
    seq BIGSERIAL PRIMARY KEY, subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
    written_by TEXT NOT NULL, written_at TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS access_tuples_live ON access_tuples (subject, relation, object) WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS access_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS access_decisions (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, body TEXT NOT NULL);
  `,
  // 30: a join code may name the template the machine joins as (issue #558). A column only: the build before runs on it.
  'ALTER TABLE join_codes ADD COLUMN IF NOT EXISTS template TEXT;',
  // 31: an access decision names its requester (issue #581): a decision for a job names the job as the requester. The
  // build before reads a decision with no job as a trial's: it still runs.
  decisionsNameTheirRequester,
];

/** Each recorded access decision's `job` becomes its `requester`, of kind job; the rest of the record is kept. */
function decisionsNameTheirRequester(db: Db): void {
  for (const r of db.all('SELECT id, body FROM access_decisions')) {
    const { job, ...rest } = JSON.parse(String(r.body)) as { job?: { userId: string; jobId: string } } & Record<string, unknown>;
    if (!job) continue;
    db.run('UPDATE access_decisions SET body = ? WHERE id = ?', JSON.stringify({ ...rest, requester: { kind: 'job', userId: job.userId, jobId: job.jobId } }), r.id as string);
  }
}

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

/** The built-in instance a left-out `answerer` / `assessor` section meant, as an escalation level. */
const BUILTIN_LEVEL: Readonly<Record<'answerer' | 'assessor', Record<string, unknown>>> = {
  answerer: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } },
  assessor: { name: 'fable', plugin: 'claude-cli', options: { model: 'fable' } },
};

/**
 * plugins.yaml's `answerer` and `assessor` sections become `escalationLevels`, in the place of the
 * first, with the meaning they had: the answerer (none when null), then the assessor, then the
 * owner. A section left out meant the built-in instance, which is written in its place. The
 * assessor `claude-cli-assessor` is the level plugin `claude-cli`; `always-escalate` meant the owner
 * decides every question, which is no levels. A custom plugin keeps its id. A document with neither
 * section keeps the built-in levels; one that does not parse is left for the owner.
 */
function escalationLevelsSection(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  if (doc.errors.length > 0 || !isMap(doc.contents) || (!doc.has('answerer') && !doc.has('assessor'))) return;
  const section = (key: 'answerer' | 'assessor'): Record<string, unknown> | null => {
    if (!doc.has(key)) return BUILTIN_LEVEL[key];
    const node = doc.get(key);
    return isMap(node) ? (node.toJSON() as Record<string, unknown>) : null;
  };
  const answerer = section('answerer');
  const assessor = section('assessor');
  const levels = assessor?.plugin === 'always-escalate' ? [] : [answerer, assessor]
    .filter((l): l is Record<string, unknown> => l !== null)
    .map((l) => (l.plugin === 'claude-cli-assessor' ? { ...l, plugin: 'claude-cli' } : l));
  const map: YAMLMap = doc.contents;
  const old = (p: { key: unknown }) => isScalar(p.key) && (p.key.value === 'answerer' || p.key.value === 'assessor');
  const at = map.items.findIndex(old);
  map.items = map.items.filter((p) => !old(p));
  map.items.splice(at, 0, doc.createPair('escalationLevels', levels));
  db.run("UPDATE config_documents SET text = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }));
}

/**
 * Every model attempt on a stored question's trail is a `level` attempt: the answerer's and the
 * assessor's, and one from before roles that is not the human's. An answerer's draft that went on to
 * the assessor (`drafted`) escalated.
 */
function levelAttempts(db: Db): void {
  for (const row of db.all('SELECT id, body FROM questions')) {
    const q = JSON.parse(String(row.body)) as { attempts?: Array<Record<string, unknown>> };
    if (!Array.isArray(q.attempts)) continue;
    let changed = false;
    q.attempts = q.attempts.map((a) => {
      const role = a.role ?? (a.tier === 'human' ? 'human' : 'level');
      if (role === 'human') {
        if (a.role === 'human') return a;
        changed = true;
        return { ...a, role };
      }
      changed = true;
      return a.outcome === 'drafted' ? { ...a, role: 'level', escalate: true, outcome: 'escalated' } : { ...a, role: 'level' };
    });
    if (changed) db.run('UPDATE questions SET body = ? WHERE id = ?', JSON.stringify(q), row.id as string);
  }
}

interface DocumentEntry { name: string; url: string; events: string[]; secretEnv: string; active: boolean }
const ENTRY_KEYS = new Set(['name', 'url', 'events', 'secretEnv', 'active']);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The webhooks document's entries, or undefined when it would not have loaded (its rules as of migration 11). */
function documentEntries(text: string): DocumentEntry[] | undefined {
  let raw: unknown;
  try { raw = parse(text); } catch { return undefined; }
  const doc = raw as { version?: unknown; webhooks?: unknown } | null;
  if (doc?.version !== 1 || !Array.isArray(doc.webhooks)) return undefined;
  const entries: DocumentEntry[] = [];
  for (const e of doc.webhooks as Record<string, unknown>[]) {
    if (typeof e !== 'object' || e === null || Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) return undefined;
    const { name, url, events, secretEnv, active = true } = e;
    if (!isText(name) || !isText(url) || !isText(secretEnv) || typeof active !== 'boolean') return undefined;
    if (!Array.isArray(events) || events.length === 0 || !events.every(isText)) return undefined;
    if (entries.some((x) => x.name === name)) return undefined;
    entries.push({ name, url, events, secretEnv, active });
  }
  return entries;
}

/**
 * Migration 14. The table was a projection of the `webhooks.yaml` config document, rewritten at each
 * load of it; the document's subscriptions become the rows (by name: a row kept keeps its id and
 * deliveries), a row it does not name goes with its open deliveries failed, and the document goes. A
 * document that would not have loaded never reached the table: the rows stay as the daemon last ran them.
 */
function webhooksDocumentToRows(db: Db): void {
  const doc = db.get("SELECT text FROM config_documents WHERE name = 'webhooks.yaml'");
  if (!doc) return;
  const entries = documentEntries(String(doc.text));
  if (entries) {
    const at = new Date().toISOString();
    for (const w of entries) {
      db.run(
        `INSERT INTO webhooks (id, name, url, events, secret_env, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, events = excluded.events, secret_env = excluded.secret_env, active = excluded.active`,
        randomUUID(), w.name, w.url, JSON.stringify(w.events), w.secretEnv, w.active ? 1 : 0, at);
    }
    const names = new Set(entries.map((w) => w.name));
    for (const row of db.all('SELECT id, name FROM webhooks')) {
      if (names.has(String(row.name))) continue;
      for (const d of db.all("SELECT id, body FROM deliveries WHERE subscription_id = ? AND status IN ('pending', 'retrying')", row.id as string)) {
        const { nextAttemptAt: _due, ...rest } = JSON.parse(String(d.body)) as Record<string, unknown>;
        const body = { ...rest, status: 'failed', updatedAt: at };
        db.run("UPDATE deliveries SET status = 'failed', next_attempt_at = NULL, body = ? WHERE id = ?", JSON.stringify(body), d.id as string);
      }
      db.run('DELETE FROM webhooks WHERE id = ?', row.id as string);
    }
  }
  db.run("DELETE FROM config_documents WHERE name = 'webhooks.yaml'");
}

/**
 * Why a build stops on a store a newer build migrated (issue #527): it would run on a schema it does not know
 * (AGENTS.md "Persisted state is the user's"). Nothing is changed; the newer build, or a backup of the store
 * from before it, runs again.
 */
export const newerStore = (what: string, known: number): string =>
  `${what}, newer than this build's ${known}: a newer hopper migrated it. Run that release or a newer one again`
  + ' (docs/deploy.md "Update channels and promotion"), or restore a backup of the database taken before it.';

/** The instance schema's version once migrated. */
export const INSTANCE_SCHEMA_VERSION = BASE_VERSION + MIGRATIONS.length;

function step(db: Db, m: Migration, from: number, record: () => void): void {
  db.exec('BEGIN');
  try {
    if (typeof m === 'string') db.exec(m);
    else m(db, from);
    record();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Migrate the instance schema up to `to` (default: the latest; a lower one only for a migration's own test). */
export function migrateInstance(db: Db, to = INSTANCE_SCHEMA_VERSION): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = (): number => Number(db.get('SELECT version FROM schema_version')?.version ?? 0);
  const record = (v: number) => () => {
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', v);
  };
  const from = version();
  if (from > INSTANCE_SCHEMA_VERSION) throw new Error(newerStore(`the database's instance schema is at version ${from}`, INSTANCE_SCHEMA_VERSION));
  if (from === 0) step(db, BASE, from, record(BASE_VERSION));
  for (let v = version(); v < to; v++) step(db, MIGRATIONS[v - BASE_VERSION]!, from, record(v + 1));
}
