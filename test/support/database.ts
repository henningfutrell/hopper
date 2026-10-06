// The database a test runs against: a fresh schema in the Postgres HOPPER_TEST_POSTGRES_URL
// names (support/postgres.ts starts one for the run), so tests never share tables.
import { createHash, randomBytes } from 'node:crypto';
import { openInstanceStore } from '../../src/store/index.ts';

export function testPostgres(): string {
  const url = process.env.HOPPER_TEST_POSTGRES_URL;
  if (!url) throw new Error('HOPPER_TEST_POSTGRES_URL is not set: run the suite through vitest (its globalSetup starts Postgres)');
  return url;
}

const withSchema = (schema: string): string => {
  const u = new URL(testPostgres());
  u.searchParams.set('schema', schema);
  return u.toString();
};

/** A fresh, empty database: a Postgres URL naming a new schema. */
export const testDatabaseUrl = (): string => withSchema(`t_${randomBytes(6).toString('hex')}`);

/** The instance version before issue #238: a new store then held the default admin account, `admin`. */
const BEFORE_NO_BOOTSTRAP = 23;
const fresh = new Set<string>();
const seeded = new Set<string>();

/**
 * `url`, its store first opened at the version before issue #238: an install from before, whose default
 * admin account `admin` holds the work — what most tests assume. A new hopper holds no user (issue #238).
 */
export function installFromBefore(url: string): string {
  if (seeded.has(url)) return url;
  openInstanceStore({ url, clock: { now: () => new Date() }, version: BEFORE_NO_BOOTSTRAP }).close();
  seeded.add(url);
  return url;
}

/** Whether `newHopper(dbPath)` was called. */
export const isNewHopper = (dbPath: string): boolean => fresh.has(dbPath);

/** The test app of `dbPath` starts as a new hopper does: no user at all (issue #238). Call before anything opens its database. */
export function newHopper(dbPath: string): void {
  fresh.add(dbPath);
}

/**
 * The database of a test app's `dbPath`: a schema named after the path, so a second start on the same
 * `dbPath` reopens it. An install from before (the default admin account there) unless `newHopper(dbPath)`.
 */
export function databaseUrlFor(dbPath: string): string {
  const url = untouchedUrlFor(dbPath);
  return fresh.has(dbPath) ? url : installFromBefore(url);
}

/** The same database, not opened yet: for a test that builds an older store itself (a migration's). */
export const untouchedUrlFor = (dbPath: string): string =>
  withSchema(`a_${createHash('sha256').update(dbPath).digest('hex').slice(0, 16)}`);

/** The schema of the admin account's tables in the database of `dbPath` (issues #158, #220: `<instance schema>_u_admin`). */
export const ownerSchemaUrlFor = (dbPath: string): string =>
  withSchema(`${new URL(databaseUrlFor(dbPath)).searchParams.get('schema')!}_u_admin`);
