// Migration 24 (issue #238): no bootstrap user. A new store ends with no user at all — the first sign-in
// makes the first user — while an install from before keeps its default admin account `admin`, its work
// and the way no sign-in reached it.
import { describe, expect, it } from 'vitest';
import { NO_SIGN_IN_IDENTITY } from '../../src/auth/index.ts';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { testPostgres } from '../support/database.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

const userSchemas = (url: string): string[] => {
  const schema = new URL(url).searchParams.get('schema')!;
  const raw = openDb(testPostgres());
  const out = raw.all('SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ? ORDER BY schema_name', `${schema}_u_%`)
    .map((r) => String(r.schema_name).slice(schema.length + 1));
  raw.close();
  return out;
};

describe('migration 24: no bootstrap user', () => {
  it('a new store has no user and no user schema', () => {
    const url = t.url();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list()).toEqual([]);
    instance.close();
    expect(userSchemas(url)).toEqual([]);
  });

  it('an install from before keeps admin and its work; no sign-in is linked to admin, as it signed in there', () => {
    const url = t.url();
    const before = openInstanceStore({ url, clock: fixedClock(), version: 23 });
    const admin = before.userStore(before.users.get('admin')!);
    const job = admin.jobs.create(spec, 50);
    admin.close();
    before.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list().map((u) => [u.id, u.workDir, u.secretPrefix])).toEqual([['admin', '', '']]);
    expect(instance.identities.userOf(NO_SIGN_IN_IDENTITY.realm, NO_SIGN_IN_IDENTITY.subject)).toBe('admin');
    const store = instance.userStore(instance.users.get('admin')!);
    expect(store.jobs.get(job.id)?.status).toBe('queued');
    store.close();
    instance.close();
    expect(userSchemas(url)).toEqual(['u_admin']);
  });

  it('an install from before whose no sign-in is already linked keeps that link', () => {
    const url = t.url();
    const before = openInstanceStore({ url, clock: fixedClock(), version: 23 });
    const bea = before.users.add('bea');
    before.close();
    const raw = t.at(url, 23);
    raw.run('INSERT INTO user_identities (realm, subject, user_id) VALUES (?, ?, ?)', NO_SIGN_IN_IDENTITY.realm, NO_SIGN_IN_IDENTITY.subject, bea.id);
    raw.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.identities.userOf(NO_SIGN_IN_IDENTITY.realm, NO_SIGN_IN_IDENTITY.subject)).toBe('bea');
    instance.close();
  });
});
