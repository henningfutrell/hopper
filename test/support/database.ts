// The database a test runs against: a fresh schema in the Postgres JOB_HOPPER_TEST_POSTGRES_URL
// names (support/postgres.ts starts one for the run), so tests never share tables.
import { createHash, randomBytes } from 'node:crypto';

export function testPostgres(): string {
  const url = process.env.JOB_HOPPER_TEST_POSTGRES_URL;
  if (!url) throw new Error('JOB_HOPPER_TEST_POSTGRES_URL is not set: run the suite through vitest (its globalSetup starts Postgres)');
  return url;
}

const withSchema = (schema: string): string => {
  const u = new URL(testPostgres());
  u.searchParams.set('schema', schema);
  return u.toString();
};

/** A fresh, empty database: a Postgres URL naming a new schema. */
export const testDatabaseUrl = (): string => withSchema(`t_${randomBytes(6).toString('hex')}`);

/** The database of a test app's `dbPath`: a schema named after the path, so a second start on the same `dbPath` reopens it. */
export const databaseUrlFor = (dbPath: string): string =>
  withSchema(`a_${createHash('sha256').update(dbPath).digest('hex').slice(0, 16)}`);
