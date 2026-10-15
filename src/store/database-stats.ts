// The hopper's Postgres as Postgres itself says (issue #947, design.md "Stack resources"): connections against
// max_connections, the database's size, the cache hit rate since the statistics were reset, lock requests waiting, the
// transactions open long, and statement latency from pg_stat_statements where it is installed and loaded (compose.yaml
// loads it). Read-only queries of Postgres's own views, over the instance store's connection; nothing is kept.
import { LONG_TRANSACTION_S, type DatabaseStats, type PostgresReading } from '../domain/stack-resources.ts';
import type { Db } from './db.ts';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function statements(db: Db): PostgresReading['statements'] {
  const ext = db.get(`SELECT n.nspname AS schema FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`);
  if (!ext) return { problem: 'pg_stat_statements is not installed in this database: compose.yaml loads it; elsewhere, add it to shared_preload_libraries and CREATE EXTENSION pg_stat_statements' };
  // The function with showtext false, not the view: the view reads every statement's text from Postgres's text file,
  // which only costs here, and a text there that is not valid UTF-8 fails the read each minute (issue #1182).
  const source = `"${String(ext.schema).replace(/"/g, '""')}".pg_stat_statements(false)`;
  try {
    const r = db.get(`SELECT coalesce(sum(calls), 0) AS calls, coalesce(sum(total_exec_time), 0) AS total FROM ${source} WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`)!;
    const calls = num(r.calls);
    return { calls, meanMs: calls > 0 ? num(r.total) / calls : 0 };
  } catch (e) {
    // Installed but not loaded: Postgres says it must be in shared_preload_libraries.
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

export function createDatabaseStats(db: Db): DatabaseStats {
  return {
    read() {
      const c = db.get(`
        SELECT current_setting('max_connections')::int AS max,
          (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend') AS total,
          (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS active,
          pg_catalog.pg_database_size(current_database()) AS size,
          (SELECT sum(blks_hit) FROM pg_catalog.pg_stat_database WHERE datname = current_database()) AS hit,
          (SELECT sum(blks_read) FROM pg_catalog.pg_stat_database WHERE datname = current_database()) AS read,
          (SELECT count(*) FROM pg_catalog.pg_locks WHERE NOT granted) AS waiting,
          (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE xact_start < now() - make_interval(secs => ?::float8)) AS long,
          (SELECT extract(epoch FROM now() - min(xact_start)) FROM pg_catalog.pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()) AS oldest`,
      LONG_TRANSACTION_S)!;
      const hit = num(c.hit);
      const blocks = hit + num(c.read);
      const oldest = c.oldest === null || c.oldest === undefined ? undefined : Math.max(0, Number(c.oldest));
      return {
        connections: { active: num(c.active), total: num(c.total), max: num(c.max) },
        databaseBytes: num(c.size),
        ...(blocks > 0 ? { cacheHitFrac: hit / blocks } : {}),
        locksWaiting: num(c.waiting),
        longTransactions: num(c.long),
        ...(oldest !== undefined ? { oldestTransactionS: oldest } : {}),
        statements: statements(db),
      };
    },
  };
}
