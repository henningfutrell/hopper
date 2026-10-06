// Migration 21 (issue #220): the built-in user `owner` becomes the default admin account, `admin`, like
// the default admin of Nexus, Argo CD and Grafana. Everything owner held moves to it — the user schema
// with all its tables, identity links, UI sessions, login codes, the work dir and the secret prefix —
// and the user `owner` is gone. A user already called `admin` (by id or by name) moves aside first, its
// work kept. Sessions and login codes name their user: no column falls back to one any more.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { testPostgres } from '../support/database.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

const schemaOf = (url: string): string => new URL(url).searchParams.get('schema')!;

const schemas = (url: string): string[] => {
  const raw = openDb(testPostgres());
  const out = raw.all('SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ? ORDER BY schema_name', `${schemaOf(url)}_u_%`)
    .map((r) => String(r.schema_name).slice(schemaOf(url).length + 1));
  raw.close();
  return out;
};

describe('migration 21: owner → the default admin account', () => {
  it('moves owner\'s schema, links, sessions and codes to admin; owner is gone', () => {
    const url = t.url();
    const before = openInstanceStore({ url, clock: fixedClock(), version: 20 });
    const owner = before.userStore(before.users.get('owner')!);
    const job = owner.jobs.create(spec, 50);
    owner.config.write('rules', 'be kind', 'missing');
    owner.close();
    const bea = before.users.add('bea');
    before.close();
    const raw = t.at(url, 20);
    raw.run("INSERT INTO user_identities (realm, subject, user_id) VALUES ('password', 'ada', 'owner'), ('corp', 'sub-1', 'bea')");
    raw.run("INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES ('t1', '2099-01-01T00:00:00.000Z', 'admin', '{}', 'owner')");
    raw.run("INSERT INTO login_codes (code_hash, expires_at, user_id) VALUES ('c1', '2099-01-01T00:00:00.000Z', 'owner')");
    raw.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list()).toEqual([
      { id: 'admin', name: 'admin', createdAt: expect.any(String), workDir: '', secretPrefix: '' },
      { ...bea, createdAt: expect.any(String) },
    ]);
    expect(instance.users.get('owner')).toBeUndefined();
    expect(instance.users.admin().id).toBe('admin');
    const admin = instance.userStore(instance.users.admin());
    expect(admin.jobs.get(job.id)?.status).toBe('queued');
    expect(admin.config.read('rules')).toBe('be kind');
    admin.close();
    expect(instance.identities.userOf('password', 'ada')).toBe('admin');
    expect(instance.identities.userOf('corp', 'sub-1')).toBe('bea');
    expect(instance.uiSessions.find('t1', '2026-10-02T10:00:00.000Z')?.userId).toBe('admin');
    expect(instance.loginCodes.take('c1', '2026-10-02T10:00:00.000Z')).toBe('admin');
    instance.close();
    expect(schemas(url)).toEqual(['u_admin', 'u_bea']);
    const after = openDb(url);
    expect(after.all("SELECT table_name, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'user_id' AND column_default IS NOT NULL")).toEqual([]);
    after.close();
  });

  it('a user already called admin moves aside, its work kept; owner takes the id and the name', () => {
    const url = t.url();
    const before = openInstanceStore({ url, clock: fixedClock(), version: 20 });
    const other = before.users.add('Admin');
    const store = before.userStore(other);
    const job = store.jobs.create(spec, 50);
    store.close();
    before.close();
    const raw = t.at(url, 20);
    raw.run("INSERT INTO user_identities (realm, subject, user_id) VALUES ('corp', 'sub-2', 'admin')");
    raw.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list().map((u) => [u.id, u.name, u.workDir, u.secretPrefix])).toEqual([
      ['admin', 'admin', '', ''],
      ['admin_2', 'Admin 2', 'users/admin', 'HOPPER_USER_ADMIN_'],
    ]);
    expect(instance.identities.userOf('corp', 'sub-2')).toBe('admin_2');
    const moved = instance.userStore(instance.users.get('admin_2')!);
    expect(moved.jobs.get(job.id)?.status).toBe('queued');
    moved.close();
    instance.close();
    expect(schemas(url)).toEqual(['u_admin', 'u_admin_2']);
  });
});
