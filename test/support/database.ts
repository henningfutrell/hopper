// The database a test runs against. SQLite by default: a file in the test's temp dir. With
// JOB_HOPPER_TEST_POSTGRES_URL set (scripts/test-postgres.sh starts a throwaway Postgres and sets
// it), a fresh schema in that database instead, so the same tests run against Postgres.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const testPostgres = (): string | undefined => process.env.JOB_HOPPER_TEST_POSTGRES_URL || undefined;

/** A fresh, empty database: `sqlite:<dir>/db.sqlite`, or a Postgres URL naming a new schema. */
export function testDatabaseUrl(dir: string): string {
  const pg = testPostgres();
  if (!pg) return `sqlite:${join(dir, 'db.sqlite')}`;
  const u = new URL(pg);
  u.searchParams.set('schema', `t_${randomBytes(6).toString('hex')}`);
  return u.toString();
}

/**
 * The database of a test app's `dbPath`: that SQLite file, or a Postgres schema named after the
 * path, so a second start on the same `dbPath` reopens the same database.
 */
export function databaseUrlFor(dbPath: string): string {
  const pg = testPostgres();
  if (!pg) return `sqlite:${dbPath}`;
  const u = new URL(pg);
  u.searchParams.set('schema', `a_${createHash('sha256').update(dbPath).digest('hex').slice(0, 16)}`);
  return u.toString();
}
