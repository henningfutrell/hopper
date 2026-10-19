// The one connection a store holds (design.md "Database"): Postgres, the only store. Synchronous on
// purpose: the Store port is synchronous, so every read-modify-write inside one call stays atomic.
// Postgres is reached through a worker thread (postgres-worker.ts) the calls block on.
//
// SQL is written with `?` placeholders, numbered ($1, $2, …) before it is sent.
import { createSyncFn } from 'synckit';
import { StoreError } from '../domain/store-error.ts';
import { instrument } from '../telemetry/instruments.ts';
import { liveReader } from '../telemetry/live.ts';
import { slowStoreCalls, statementOf } from './slow-calls.ts';

/** Each store call's time, by its statement's verb and table (issue #1486, design.md "Telemetry"): never its SQL or values. */
const callDuration = instrument((m) => m.createHistogram('hopper.db.call.duration', { unit: 's', description: 'How long a store call blocked the process.' }));

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

/** HOPPER_DATABASE_URL checked: `postgres://…` or `postgresql://…`, else throws. */
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
/**
 * How long Postgres runs a statement before it cancels it (issue #1003); the worker drops a connection that gives no
 * answer a tenth after that. Both end inside CALL_TIMEOUT_MS, so a call that waits fails with its reason and leaves no
 * statement on its connection for the calls after it to wait behind.
 */
export const STATEMENT_TIMEOUT_MS = 25_000;

interface WorkerCall {
  (op: 'open', handle: 0, url: string, params: [timeoutMs: number]): { handle: number };
  (op: 'exec' | 'query', handle: number, sql: string, params: Param[]): { rows: Row[]; changes: number };
  (op: 'close', handle: number, sql: '', params: []): null;
}

/** One worker per process (synckit's), one connection per Db in it. */
let worker: WorkerCall | undefined;
/** The Dbs open now: the store's connections (issue #1486, design.md "Telemetry: what runs now"). */
let open = 0;
liveReader('hopper.db.connections', () => [{ value: open, attributes: {} }]);

/** `timeoutMs`: how long a statement may run (default STATEMENT_TIMEOUT_MS, at most it). */
export function openDb(url: string, o: { timeoutMs?: number } = {}): Db {
  worker ??= createSyncFn(new URL('./postgres-worker.ts', import.meta.url).pathname, { timeout: CALL_TIMEOUT_MS }) as WorkerCall;
  const call = worker;
  const { handle } = call('open', 0, parseDatabaseUrl(url), [Math.min(o.timeoutMs ?? STATEMENT_TIMEOUT_MS, STATEMENT_TIMEOUT_MS)]);
  // Each call blocks the event loop while it lasts: a slow one is kept, for the watchdog to name (issue #1154).
  const timed = <T>(sql: string, run: () => T): T => {
    const from = performance.now();
    try { return run(); } catch (e) {
      throw e instanceof StoreError ? e : new StoreError(e instanceof Error ? e.message : String(e), { cause: e });
    } finally {
      const to = performance.now(), statement = statementOf(sql);
      slowStoreCalls.record(from, to, statement);
      callDuration().record((to - from) / 1000, { 'db.query.summary': statement });
    }
  };
  const query = (sql: string, params: Param[]) => timed(sql, () => call('query', handle, numberPlaceholders(sql), params));
  open++;
  let closed = false;
  return {
    exec: (sql) => { timed(sql, () => call('exec', handle, sql, [])); },
    run: (sql, ...p) => ({ changes: query(sql, p).changes }),
    get: (sql, ...p) => query(sql, p).rows[0],
    all: (sql, ...p) => query(sql, p).rows,
    close: () => {
      if (!closed) { closed = true; open--; }
      call('close', handle, '', []);
    },
  };
}
