// Reads off the event loop (issue #2392, design.md "Database": "Reads off the loop"). The store's own connection blocks
// the event loop on each call (db.ts); the HTTP read routes that read many rows read through here instead: an async
// pg.Pool on the main thread, one per database server and process, so a read that waits on the database holds no timer
// and no other request. Read only: each connection is `default_transaction_read_only`, so nothing here writes. A user's
// schema is set on the connection when it differs from the one it has, then the query runs.
import pg from 'pg';
import { StoreError } from '../domain/store-error.ts';
import { numberPlaceholders, parseDatabaseUrl, STATEMENT_TIMEOUT_MS, type Param, type Row } from './db.ts';

export interface ReadDb {
  get(sql: string, ...params: Param[]): Promise<Row | undefined>;
  all(sql: string, ...params: Param[]): Promise<Row[]>;
}

/** The most connections one process's pool opens to one database server: reads beyond it wait for one. */
export const READ_POOL_SIZE = 4;

/** BIGINT as a number, as the store's own connection reads it (postgres-worker.ts); this pool's alone, not pg's default. */
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === pg.types.builtins.INT8 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

const pools = new Map<string, pg.Pool>();
/** The schema each pooled connection's search_path names now. */
const schemaOf = new WeakMap<pg.PoolClient, string>();

function poolFor(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString, max: READ_POOL_SIZE, idleTimeoutMillis: 30_000, allowExitOnIdle: true, types,
      application_name: 'hopper-reads', statement_timeout: STATEMENT_TIMEOUT_MS, connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
      options: '-c default_transaction_read_only=on', keepAlive: true,
    });
    // An idle connection that drops is the pool's to replace; the read that next needs one connects again.
    pool.on('error', () => {});
    pools.set(connectionString, pool);
  }
  return pool;
}

/** The reads of the schema `url` names (`?schema=`, as openDb takes it), through the process's pool for its server. */
export function readDb(url: string): ReadDb {
  const u = new URL(parseDatabaseUrl(url));
  const schema = u.searchParams.get('schema') ?? undefined;
  u.searchParams.delete('schema');
  const pool = poolFor(u.toString());
  const query = async (sql: string, params: Param[]): Promise<Row[]> => {
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      if (schema && schemaOf.get(client) !== schema) {
        await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
        schemaOf.set(client, schema);
      }
      const rows = (await client.query(numberPlaceholders(sql), params)).rows as Row[];
      client.release();
      return rows;
    } catch (e) {
      // A connection that failed is not given back: the pool opens a new one.
      client?.release(e instanceof Error ? e : true);
      const err = e as Error & { code?: string };
      throw new StoreError(`postgres: ${err.message}${err.code ? ` (${err.code})` : ''}`, { cause: e });
    }
  };
  return {
    get: async (sql, ...p) => (await query(sql, p))[0],
    all: (sql, ...p) => query(sql, p),
  };
}
