// The one connection a store holds, over either database (design.md "Database"): SQLite for local
// use, Postgres for a deploy. Synchronous on purpose: the Store port is synchronous, so every
// read-modify-write inside one call stays atomic exactly as it was over node:sqlite. Postgres is
// reached through a worker thread (postgres-worker.ts) the calls block on.
//
// SQL is written once, with `?` placeholders; the Postgres side numbers them ($1, $2, …). Keep the
// SQL to what both dialects mean the same way: no `INSERT OR REPLACE`, `RETURNING` for generated keys.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSyncFn } from 'synckit';

export type Param = string | number | null;
export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  /** One or more statements, no parameters (DDL, BEGIN/COMMIT). */
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number };
  get(sql: string, ...params: Param[]): Row | undefined;
  all(sql: string, ...params: Param[]): Row[];
  close(): void;
}

/** A parsed JOB_HOPPER_DATABASE_URL. */
export type DatabaseTarget = { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string };

/** `sqlite:<path>` (absolute or relative to the working directory) or `postgres://…` / `postgresql://…`. */
export function parseDatabaseUrl(url: string): DatabaseTarget {
  if (/^postgres(ql)?:\/\//.test(url)) return { kind: 'postgres', url };
  const m = /^sqlite:(?:\/\/)?(.+)$/.exec(url);
  if (m) return { kind: 'sqlite', path: m[1]! };
  throw new Error('must be sqlite:<path> or postgres://user:password@host:port/database');
}

export function openSqlite(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    dialect: 'sqlite',
    exec: (sql) => db.exec(sql),
    run: (sql, ...p) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
    get: (sql, ...p) => db.prepare(sql).get(...p) as Row | undefined,
    all: (sql, ...p) => db.prepare(sql).all(...p) as Row[],
    close: () => db.close(),
  };
}

/** `?` → `$1`, `$2`, … (the store's SQL holds no `?` inside a literal). */
export function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** The most a call may block the process before it fails: a stuck database must not hang the daemon silently. */
const CALL_TIMEOUT_MS = 30_000;

interface WorkerCall {
  (op: 'open', handle: 0, url: string, params: []): { handle: number };
  (op: 'exec' | 'query', handle: number, sql: string, params: Param[]): { rows: Row[]; changes: number };
  (op: 'close', handle: number, sql: '', params: []): null;
}

/** One worker per process (synckit's), one connection per Db in it. */
let worker: WorkerCall | undefined;

export function openPostgres(url: string): Db {
  worker ??= createSyncFn(new URL('./postgres-worker.ts', import.meta.url).pathname, { timeout: CALL_TIMEOUT_MS }) as WorkerCall;
  const call = worker;
  const { handle } = call('open', 0, url, []);
  const query = (sql: string, params: Param[]) => call('query', handle, numberPlaceholders(sql), params);
  return {
    dialect: 'postgres',
    exec: (sql) => { call('exec', handle, sql, []); },
    run: (sql, ...p) => ({ changes: query(sql, p).changes }),
    get: (sql, ...p) => query(sql, p).rows[0],
    all: (sql, ...p) => query(sql, p).rows,
    close: () => { call('close', handle, '', []); },
  };
}

export function openDb(target: DatabaseTarget): Db {
  return target.kind === 'sqlite' ? openSqlite(target.path) : openPostgres(target.url);
}
