import type { Clock, UserStore } from '../../src/domain/ports.ts';
import type { JobSpec } from '../../src/domain/types.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { migrateInstance } from '../../src/store/migrations.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { testDatabaseUrl } from '../support/database.ts';

export function fixedClock(iso = '2026-10-02T10:00:00.000Z'): Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => t, set: (v: string) => { t = new Date(v); } };
}

export const spec: JobSpec = { executor: 'test', payload: { n: 1 }, goal: 'g' };

/**
 * Temp stores: `url()` is a fresh, empty database (support/database.ts: a new Postgres schema).
 * `open` is the store of the user `admin` (its instance closed with it); `at` the raw database
 * migrated to one instance version, for a migration's own test.
 */
export function useTempStore() {
  return {
    url: () => testDatabaseUrl(),
    open: (url: string, clock = fixedClock(), idGen?: () => string): UserStore => {
      const instance = openInstanceStore({ url, clock, ...(idGen ? { idGen } : {}) });
      const admin = instance.userStore(instance.users.admin());
      return { ...admin, close: () => { admin.close(); instance.close(); } };
    },
    at: (url: string, version: number): Db => {
      const db = openDb(url);
      migrateInstance(db, version);
      return db;
    },
    /** A user schema of its own (no instance), migrated to one tenant version, for a tenant migration's own test. */
    tenantAt: (url: string, version: number): Db => {
      const u = new URL(url);
      u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
      const db = openDb(u.toString());
      migrateTenant(db, version);
      return db;
    },
  };
}
