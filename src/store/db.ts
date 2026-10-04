// The one connection a store holds (design.md "Database"): Postgres, the only store. Synchronous on
// purpose: the Store port is synchronous, so every read-modify-write inside one call stays atomic.
// Postgres is reached through a worker thread (postgres-worker.ts) the calls block on.
//
// SQL is written with `?` placeholders, numbered ($1, $2, …) before it is sent.
import { createSyncFn } from 'synckit';

export type Param = string | number | null;
export type Row = Record<string, unknown>;

export interface Db {
  /** One or more statements, no parameters (DDL, BEGIN/COMMIT). */
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number };
  get(sql: string, ...params: Param[]): Row | undefined;
  all(sql: string, ...params: Param[]): Row[];
  close(): void;
}

/** JOB_HOPPER_DATABASE_URL checked: `postgres://…` or `postgresql://…`, else throws. */
export function parseDatabaseUrl(url: string): string {
  if (/^postgres(ql)?:\/\//.test(url)) return url;
  throw new Error('must be postgres://user:password@host:port/database');
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

export function openDb(url: string): Db {
  worker ??= createSyncFn(new URL('./postgres-worker.ts', import.meta.url).pathname, { timeout: CALL_TIMEOUT_MS }) as WorkerCall;
  const call = worker;
  const { handle } = call('open', 0, parseDatabaseUrl(url), []);
  const query = (sql: string, params: Param[]) => call('query', handle, numberPlaceholders(sql), params);
  return {
    exec: (sql) => { call('exec', handle, sql, []); },
    run: (sql, ...p) => ({ changes: query(sql, p).changes }),
    get: (sql, ...p) => query(sql, p).rows[0],
    all: (sql, ...p) => query(sql, p).rows,
    close: () => { call('close', handle, '', []); },
  };
}
