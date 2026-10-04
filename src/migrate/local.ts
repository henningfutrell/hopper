// Moving a hopper off the machine it ran on (design.md "Migrating a local install"): the SQLite
// file, the config directory's plugins.yaml, webhooks.yaml, rules.md and auth.yaml, and the secret files they
// pointed at, into the database JOB_HOPPER_DATABASE_URL names — the documents rewritten for the
// options that replaced file paths, the secrets written out as environment lines for the deploy to
// supply. Nothing is changed where it came from: the SQLite file is read through a snapshot.
//
// The target must be empty, so a migration never merges two histories. Every row keeps its seq;
// Postgres's sequences are moved past the copied ones.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { authDocumentProblem } from '../auth/index.ts';
import type { ConfigDocumentName } from '../domain/ports.ts';
import { pluginsFileProblem } from '../plugins/plugins-file.ts';
import { openDb, parseDatabaseUrl, type Db, type Row } from '../store/db.ts';
import { migrate } from '../store/migrations.ts';
import { webhooksFileProblem } from '../webhooks/config.ts';

/** Every table of the store, parents first; `seq` names a generated key Postgres keeps a sequence for. */
const TABLES: readonly { name: string; key: string; seq: boolean }[] = [
  { name: 'jobs', key: 'seq', seq: true },
  { name: 'lanes', key: 'id', seq: false },
  { name: 'decisions', key: 'seq', seq: true },
  { name: 'events', key: 'seq', seq: true },
  { name: 'webhooks', key: 'seq', seq: true },
  { name: 'deliveries', key: 'seq', seq: true },
  { name: 'settings', key: 'key', seq: false },
  { name: 'questions', key: 'seq', seq: true },
  { name: 'ui_sessions', key: 'token_hash', seq: false },
  { name: 'config_documents', key: 'name', seq: false },
  { name: 'login_codes', key: 'code_hash', seq: false },
];

const BATCH = 200;

export interface MigrateLocalOptions {
  /** The SQLite file the hopper ran on. */
  sqlite: string;
  /** The directory that held plugins.yaml, webhooks.yaml, rules.md; undefined: none. */
  configDir?: string;
  /** JOB_HOPPER_DATABASE_URL: where everything goes. Must be empty. */
  target: string;
  log(line: string): void;
}

export interface MigrateLocalResult {
  /** Rows copied, by table. */
  rows: Record<string, number>;
  /** Documents written, by name. */
  documents: ConfigDocumentName[];
  /** Environment lines (`NAME=value`) the deploy must supply: the secrets the documents no longer point at. */
  secrets: Record<string, string>;
  /** What was rewritten, one line each. */
  notes: string[];
}

export class MigrateRefusal extends Error {}

const expand = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const read = (p: string): string => readFileSync(expand(p), 'utf8');

/** A PEM as one environment line: newlines as `\n` escapes (pemFromEnv reads them back). */
const oneLine = (pem: string): string => pem.trim().replaceAll('\n', '\\n');

/** The rows of `table` in a SQLite file opened read-only, in key order. */
function snapshot(sqlite: string): { db: Db; done(): void } {
  if (!existsSync(sqlite)) throw new MigrateRefusal(`no SQLite file at ${sqlite}`);
  const dir = mkdtempSync(join(tmpdir(), 'job-hopper-migrate-'));
  const copy = join(dir, 'snapshot.sqlite');
  // VACUUM INTO: one consistent copy, WAL included, without writing to the original.
  const src = new DatabaseSync(sqlite, { readOnly: true });
  try { src.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { src.close(); }
  const db = openDb({ kind: 'sqlite', path: copy });
  migrate(db);
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function copyTable(from: Db, to: Db, table: string, key: string): number {
  const rows = from.all(`SELECT * FROM ${table} ORDER BY ${key}`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const cols = Object.keys(batch[0]!);
    const values = batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    to.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`, ...batch.flatMap((r: Row) => cols.map((c) => r[c] as string | number | null)));
  }
  return rows.length;
}

const optionsOf = (entry: unknown): YAMLMap | undefined => {
  if (!isMap(entry)) return undefined;
  const o = entry.get('options', true);
  return isMap(o) ? o : undefined;
};

/** plugins.yaml with every file-path option replaced by what replaced it; the secrets it read. */
function rewritePlugins(doc: Document, secrets: Record<string, string>, notes: string[]): void {
  const sources = doc.get('jobSources', true);
  for (const s of isSeq(sources) ? sources.items : []) {
    const plugin = isMap(s) ? s.get('plugin') : undefined;
    const o = optionsOf(s);
    if (!o || !o.has('appFile')) continue;
    const appFile = o.get('appFile');
    o.delete('appFile');
    if (plugin === 'github-gh') {
      if (appFile === null) o.set('appKeyEnv', null);
      notes.push(`github-gh: appFile replaced by appKeyEnv${appFile === null ? ': null' : ' (GITHUB_APP_PRIVATE_KEY)'}`);
    } else if (plugin === 'github-app' && typeof appFile === 'string') {
      if (!existsSync(expand(appFile))) { notes.push(`github-app: ${appFile} not found; appId and slug left unset`); continue; }
      const app = JSON.parse(read(appFile)) as { appId: number; slug: string; privateKeyFile: string };
      o.set('appId', app.appId);
      o.set('slug', app.slug);
      secrets.GITHUB_APP_PRIVATE_KEY = oneLine(read(app.privateKeyFile));
      notes.push(`github-app: appFile replaced by appId ${app.appId} and slug ${app.slug}; its key → GITHUB_APP_PRIVATE_KEY`);
    }
  }
  const notifiers = doc.get('notifiers', true);
  for (const n of isSeq(notifiers) ? notifiers.items : []) {
    const o = optionsOf(n);
    if (!isMap(n) || n.get('plugin') !== 'grokbot-routine' || !o?.has('envFile')) continue;
    const envFile = String(o.get('envFile'));
    o.delete('envFile');
    if (o.items.length === 0) n.delete('options');
    if (existsSync(expand(envFile))) {
      const env = parseEnv(read(envFile));
      for (const k of ['GROKBOT_WEBHOOK_URL', 'GROKBOT_WEBHOOK_KEY'] as const) if (env[k]?.trim()) secrets[k] = env[k].trim();
    }
    notes.push(`grokbot-routine: envFile replaced by GROKBOT_WEBHOOK_URL and GROKBOT_WEBHOOK_KEY`);
  }
  const router = doc.get('router', true);
  const ro = optionsOf(router);
  if (isMap(router) && router.get('plugin') === 'jev-router' && ro?.has('typesafeKeyFile')) {
    const keyFile = String(ro.get('typesafeKeyFile'));
    ro.delete('typesafeKeyFile');
    if (existsSync(expand(keyFile)) && read(keyFile).trim()) secrets.TYPESAFE_API_KEY = read(keyFile).trim();
    notes.push('jev-router: typesafeKeyFile replaced by TYPESAFE_API_KEY');
  }
}

/** webhooks.yaml with every `secretFile` replaced by a `secretEnv` of its own. */
function rewriteWebhooks(doc: Document, secrets: Record<string, string>, notes: string[]): void {
  const list = doc.get('webhooks', true);
  for (const w of isSeq(list) ? list.items : []) {
    if (!isMap(w) || !w.has('secretFile')) continue;
    const name = String(w.get('name'));
    const variable = `WEBHOOK_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    secrets[variable] = read(String(w.get('secretFile'))).trim();
    w.delete('secretFile');
    w.set('secretEnv', variable);
    notes.push(`webhook ${name}: secretFile replaced by secretEnv ${variable}`);
  }
}

/** auth.yaml with every client secret (inline or a file) moved to a `clientSecretEnv`, every IdP certificate file inlined. */
function rewriteAuth(doc: Document, secrets: Record<string, string>, notes: string[]): void {
  const list = doc.get('providers', true);
  for (const p of isSeq(list) ? list.items : []) {
    if (!isMap(p)) continue;
    const name = String(p.get('name'));
    if (p.has('clientSecret') || p.has('clientSecretFile')) {
      const variable = `AUTH_CLIENT_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      secrets[variable] = p.has('clientSecret') ? String(p.get('clientSecret')) : read(String(p.get('clientSecretFile'))).trim();
      p.delete('clientSecret');
      p.delete('clientSecretFile');
      p.set('clientSecretEnv', variable);
      notes.push(`auth provider ${name}: client secret moved to ${variable}`);
    }
    if (p.has('idpCertFile')) {
      p.set('idpCert', read(String(p.get('idpCertFile'))));
      p.delete('idpCertFile');
      notes.push(`auth provider ${name}: idpCertFile inlined as idpCert`);
    }
  }
}

function documentsFrom(dir: string, secrets: Record<string, string>, notes: string[]): Partial<Record<ConfigDocumentName, string>> {
  const out: Partial<Record<ConfigDocumentName, string>> = {};
  const at = (name: string) => join(expand(dir), name);
  if (existsSync(at('plugins.yaml'))) {
    const doc = parseDocument(readFileSync(at('plugins.yaml'), 'utf8'));
    if (doc.errors.length) throw new MigrateRefusal(`plugins.yaml does not parse: ${doc.errors[0]!.message}`);
    rewritePlugins(doc, secrets, notes);
    const problem = pluginsFileProblem(doc.toJS());
    if (problem) throw new MigrateRefusal(`plugins.yaml would not load after the rewrite: ${problem}`);
    out['plugins.yaml'] = doc.toString({ lineWidth: 0 });
  }
  if (existsSync(at('webhooks.yaml'))) {
    const doc = parseDocument(readFileSync(at('webhooks.yaml'), 'utf8'));
    if (doc.errors.length) throw new MigrateRefusal(`webhooks.yaml does not parse: ${doc.errors[0]!.message}`);
    rewriteWebhooks(doc, secrets, notes);
    const problem = webhooksFileProblem(doc.toJS());
    if (problem) throw new MigrateRefusal(`webhooks.yaml would not load after the rewrite: ${problem}`);
    out['webhooks.yaml'] = doc.toString({ lineWidth: 0 });
  }
  if (existsSync(at('rules.md'))) out['rules.md'] = readFileSync(at('rules.md'), 'utf8');
  if (existsSync(at('auth.yaml'))) {
    const doc = parseDocument(readFileSync(at('auth.yaml'), 'utf8'));
    if (doc.errors.length) throw new MigrateRefusal(`auth.yaml does not parse: ${doc.errors[0]!.message}`);
    rewriteAuth(doc, secrets, notes);
    const problem = authDocumentProblem(doc.toJS());
    if (problem) throw new MigrateRefusal(`auth.yaml would not load after the rewrite: ${problem}`);
    out['auth.yaml'] = doc.toString({ lineWidth: 0 });
  }
  return out;
}

export function migrateLocal(o: MigrateLocalOptions): MigrateLocalResult {
  const secrets: Record<string, string> = {};
  const notes: string[] = [];
  const docs = o.configDir ? documentsFrom(o.configDir, secrets, notes) : {};
  const target = openDb(parseDatabaseUrl(o.target));
  const source = snapshot(o.sqlite);
  try {
    migrate(target);
    const busy = TABLES.filter((t) => Number(target.get(`SELECT count(*) AS n FROM ${t.name}`)!.n) > 0).map((t) => t.name);
    if (busy.length) throw new MigrateRefusal(`the target database is not empty (${busy.join(', ')}); migrate into an empty one, before the daemon first starts on it`);
    const rows: Record<string, number> = {};
    target.exec(target.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      for (const t of TABLES) rows[t.name] = copyTable(source.db, target, t.name, t.key);
      const documents = Object.keys(docs) as ConfigDocumentName[];
      const at = new Date().toISOString();
      for (const name of documents) {
        target.run('INSERT INTO config_documents (name, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at', name, docs[name]!, at);
      }
      if (target.dialect === 'postgres') {
        for (const t of TABLES.filter((x) => x.seq)) {
          target.get(`SELECT setval(pg_get_serial_sequence('${t.name}', 'seq'), coalesce((SELECT max(seq) FROM ${t.name}), 0) + 1, false)`);
        }
      }
      target.exec('COMMIT');
      for (const [table, n] of Object.entries(rows)) o.log(`migrate: ${table}: ${n} rows`);
      for (const name of documents) o.log(`migrate: ${name} written`);
      for (const n of notes) o.log(`migrate: ${n}`);
      return { rows, documents, secrets, notes };
    } catch (e) {
      target.exec('ROLLBACK');
      throw e;
    }
  } finally {
    source.done();
    target.close();
  }
}

/** The secrets as an environment file: `NAME=value` lines, values on one line (a PEM's newlines as `\n`). */
export function secretsEnvFile(secrets: Record<string, string>): string {
  const lines = Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
  return `# job-hopper secrets moved out of files by job-hopper migrate-local (design.md "Secrets").\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}
