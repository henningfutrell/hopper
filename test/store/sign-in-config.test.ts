// The sign-in config (issue #200, design.md "Sign-in: realms"): the config record `sign-in` (the
// realms in order, the login code, no sign-in) and the password accounts, rows of `password_accounts`,
// read and replaced as one against the version read, so two admins changing it at once cannot both
// win. The record itself never holds an account.
import { describe, expect, it } from 'vitest';
import type { StoredSignIn } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

const SIGN_IN: StoredSignIn = {
  version: 1,
  local: { enabled: false },
  none: { role: 'operator' },
  realms: [
    { name: 'gh', label: 'GitHub', type: 'github', clientId: 'g', clientSecret: 'gh-secret', roles: { admin: { subjects: ['1'] } } },
    { name: 'staff', type: 'password', enabled: false, users: [{ username: 'bea', passwordHash: HASH, role: 'admin' }, { username: 'ada', passwordHash: HASH, role: 'viewer' }] },
  ],
};

describe('sign-in config', () => {
  it('written whole and read back the same, in realm order, after a reopen', () => {
    const url = t.url();
    const a = openInstanceStore({ url, clock: fixedClock() });
    const version = a.signInConfig.version();
    expect(a.signInConfig.write(SIGN_IN, version)).toBe(true);
    a.close();
    const b = openInstanceStore({ url, clock: fixedClock() });
    const back = b.signInConfig.read();
    const record = b.config.read('sign-in');
    b.close();
    expect(back).toEqual({ ...SIGN_IN, realms: [SIGN_IN.realms[0], { ...SIGN_IN.realms[1], users: [SIGN_IN.realms[1]!.users![1], SIGN_IN.realms[1]!.users![0]] }] });
    expect(JSON.stringify(record)).not.toContain('argon2');
  });

  it('a write against a version that moved is refused and changes nothing', () => {
    const s = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const version = s.signInConfig.version();
    expect(s.signInConfig.write(SIGN_IN, version)).toBe(true);
    expect(s.signInConfig.version()).not.toBe(version);
    expect(s.signInConfig.write({ version: 1, realms: [] }, version)).toBe(false);
    expect(s.signInConfig.read().realms.map((r) => r.name)).toEqual(['gh', 'staff']);
    s.close();
  });
});
