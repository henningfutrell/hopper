// Password sign-in is the fallback (issue #219, design.md "Sign-in: realms"): there is always a password
// realm that is on with an admin account, so the username and password form is always offered. A
// sign-in config without one gets one — the account `admin` with a password made at start.
import { describe, expect, it } from 'vitest';
import { hasPasswordFallback, withPasswordFallback } from '../../src/auth/fallback.ts';
import type { StoredSignIn } from '../../src/domain/ports.ts';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';
const NEW = '$argon2id$v=19$m=65536,t=3,p=4$b3RoZXJzYWx0b3RoZXI$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';
const oidc = { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'h' };
const signIn = (...realms: StoredSignIn['realms']): StoredSignIn => ({ version: 1, realms });

describe('hasPasswordFallback', () => {
  it.each<[string, StoredSignIn, boolean]>([
    ['a password realm that is on with an admin account', signIn({ name: 'p', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'admin' }] }), true],
    ['no realm', signIn(), false],
    ['a password realm with no account', signIn({ name: 'p', type: 'password', users: [] }), false],
    ['a password realm whose accounts are not admin', signIn({ name: 'p', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }] }), false],
    ['a password realm that is off', signIn({ name: 'p', type: 'password', enabled: false, users: [{ username: 'ada', passwordHash: HASH, role: 'admin' }] }), false],
    ['only other realm types', signIn(oidc), false],
  ])('%s: %s', (_what, s, has) => {
    expect(hasPasswordFallback(s)).toBe(has);
  });
});

describe('withPasswordFallback', () => {
  it('has it already: nothing to add', () => {
    expect(withPasswordFallback(signIn({ name: 'p', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'admin' }] }), NEW)).toBeUndefined();
  });

  it('no password realm: adds the realm password with the account admin, after the others', () => {
    const r = withPasswordFallback(signIn(oidc), NEW)!;
    expect(r).toMatchObject({ realm: 'password', username: 'admin' });
    expect(r.next.realms).toEqual([oidc, { name: 'password', label: 'Password', type: 'password', users: [{ username: 'admin', passwordHash: NEW, role: 'admin' }] }]);
    expect(hasPasswordFallback(r.next)).toBe(true);
  });

  it('a fresh hopper\'s password realm with no account gets the account admin', () => {
    const r = withPasswordFallback(signIn({ name: 'password', label: 'Password', type: 'password', users: [] }), NEW)!;
    expect(r.next.realms).toEqual([{ name: 'password', label: 'Password', type: 'password', users: [{ username: 'admin', passwordHash: NEW, role: 'admin' }] }]);
  });

  it('the first password realm is turned on and keeps its accounts; a taken username gets a number', () => {
    const before = signIn(
      { name: 'staff', type: 'password', enabled: false, users: [{ username: 'Admin', passwordHash: HASH, role: 'viewer' }] },
      { name: 'more', type: 'password', users: [] },
    );
    const r = withPasswordFallback(before, NEW)!;
    expect(r).toMatchObject({ realm: 'staff', username: 'admin-2' });
    expect(r.next.realms[0]).toEqual({ name: 'staff', type: 'password', users: [{ username: 'Admin', passwordHash: HASH, role: 'viewer' }, { username: 'admin-2', passwordHash: NEW, role: 'admin' }] });
    expect(before.realms[0]!.enabled).toBe(false);
  });

  it('the name password taken by another realm type: the new realm takes another', () => {
    const r = withPasswordFallback(signIn({ ...oidc, name: 'password' }), NEW)!;
    expect(r.realm).toBe('password-2');
    expect(r.next.realms.map((x) => x.name)).toEqual(['password', 'password-2']);
  });
});
