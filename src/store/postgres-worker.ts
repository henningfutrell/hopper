// The Postgres side of db.ts: a worker thread answering one call at a time while the calling
// thread waits (synckit). synckit starts one worker per process, so the worker keeps one pg client
// per open Db, by handle: a transaction's statements share their Db's client. A dropped connection fails the call it broke; the next call outside a
// transaction connects again. A call never waits without end (issue #1003): Postgres cancels a statement after its
// time (`statement_timeout`), and a connection that gives no answer a tenth after that — a network that drops what it
// carries — is dropped, so the call fails and the next one does not queue behind a statement that never ends.
import pg from 'pg';
import { runAsWorker } from 'synckit';

// BIGINT (seq columns, count(*)) as a number: every seq the store hands out fits in 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

type Param = string | number | null;

interface Connection { url: string; timeoutMs: number; client?: pg.Client; inTx: boolean }

const connections = new Map<number, Connection>();
let nextHandle = 1;

/** `?schema=<name>` (hopper's own parameter, stripped before pg sees the URL): the schema the store lives in, created if absent. */
function split(raw: string): { connectionString: string; schema?: string } {
  const u = new URL(raw);
  const schema = u.searchParams.get('schema') ?? undefined;
  u.searchParams.delete('schema');
  return { connectionString: u.toString(), ...(schema ? { schema } : {}) };
}

async function connect(conn: Connection): Promise<pg.Client> {
  const { connectionString, schema } = split(conn.url);
  const c = new pg.Client({ connectionString, application_name: 'hopper', statement_timeout: conn.timeoutMs, keepAlive: true, connectionTimeoutMillis: conn.timeoutMs });
  c.on('error', () => { if (conn.client === c) conn.client = undefined; });
  await c.connect();
  if (schema) {
    const id = `"${schema.replaceAll('"', '""')}"`;
    await answered(conn, c, c.query(`CREATE SCHEMA IF NOT EXISTS ${id}`));
    await answered(conn, c, c.query(`SET search_path TO ${id}`));
  }
  conn.client = c;
  return c;
}

const TX = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

/** `q`, or a failure once the connection gave no answer in its time: then the connection is dropped. */
async function answered<T>(conn: Connection, c: pg.Client, q: Promise<T>): Promise<T> {
  const ms = Math.round(conn.timeoutMs * 1.1);
  let timer: NodeJS.Timeout | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (conn.client === c) conn.client = undefined;
      // pg's own end() waits for the statement that never answers; destroy the socket under it.
      (c as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
      reject(new Error(`no answer in ${(ms / 1000).toFixed(1)} s: the connection was dropped`));
    }, ms);
  });
  q.catch(() => { /* failed after the drop: the drop's reason is the answer */ });
  try { return await Promise.race([q, silent]); } finally { clearTimeout(timer); }
}

async function call(conn: Connection, op: 'exec' | 'query', sql: string, params: Param[]) {
  const tx = TX.exec(sql)?.[1]?.toUpperCase();
  // The server already rolled back a transaction whose connection died.
  if (tx === 'ROLLBACK' && !conn.client) { conn.inTx = false; return { rows: [], changes: 0 }; }
  if (!conn.client && conn.inTx) throw new Error('postgres: the connection was lost inside a transaction');
  const c = conn.client ?? await connect(conn);
  try {
    const r = await answered(conn, c, c.query(sql, op === 'query' ? params : undefined));
    if (tx === 'BEGIN') conn.inTx = true;
    else if (tx) conn.inTx = false;
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    return { rows: (last?.rows ?? []) as Record<string, unknown>[], changes: last?.rowCount ?? 0 };
  } catch (e) {
    if (tx && tx !== 'BEGIN') conn.inTx = false;
    const err = e as Error & { code?: string };
    throw new Error(`postgres: ${err.message}${err.code ? ` (${err.code})` : ''}`, { cause: e });
  }
}

runAsWorker(async (op: 'open' | 'exec' | 'query' | 'close', handle: number, sql: string, params: Param[]) => {
  if (op === 'open') {
    const conn: Connection = { url: sql, timeoutMs: params[0] as number, inTx: false };
    await connect(conn);
    const h = nextHandle++;
    connections.set(h, conn);
    return { handle: h };
  }
  const conn = connections.get(handle);
  if (!conn) throw new Error('postgres: this database is closed');
  if (op === 'close') {
    connections.delete(handle);
    await conn.client?.end();
    return null;
  }
  return call(conn, op, sql, params);
});
