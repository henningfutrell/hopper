// A build refuses a store a newer build migrated (issue #527): rolled back to an older release on the same
// database, it said nothing and failed later, on whatever the newer schema had changed. Now it stops at the
// start, naming both versions, and changes nothing.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { INSTANCE_SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { TENANT_SCHEMA_VERSION, migrateTenant } from '../../src/store/tenant-migrations.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const version = (db: ReturnType<typeof openDb>): number => Number(db.get('SELECT version FROM schema_version')!.version);

describe('a store newer than the build', () => {
  it('the instance store: the start stops, naming both versions, the store as it was', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock() }).close();
    const raw = openDb(url);
    raw.run('UPDATE schema_version SET version = ?', INSTANCE_SCHEMA_VERSION + 1);
    raw.close();

    expect(() => openInstanceStore({ url, clock: fixedClock() })).toThrow(
      `the database's instance schema is at version ${INSTANCE_SCHEMA_VERSION + 1}, newer than this build's ${INSTANCE_SCHEMA_VERSION}`);
    const after = openDb(url);
    expect(version(after)).toBe(INSTANCE_SCHEMA_VERSION + 1);
    after.close();
  });

  it('a user schema: its migration stops, naming both versions', () => {
    const raw = t.tenantAt(t.url(), TENANT_SCHEMA_VERSION);
    raw.run('UPDATE schema_version SET version = ?', TENANT_SCHEMA_VERSION + 2);
    expect(() => migrateTenant(raw)).toThrow(
      `a user schema is at version ${TENANT_SCHEMA_VERSION + 2}, newer than this build's ${TENANT_SCHEMA_VERSION}`);
    expect(version(raw)).toBe(TENANT_SCHEMA_VERSION + 2);
    raw.close();
  });

  it('a store at the build\'s own version opens as before', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock() }).close();
    openInstanceStore({ url, clock: fixedClock() }).close();
  });
});
