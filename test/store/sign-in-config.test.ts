// The sign-in config (design.md "Sign-in: realms"): the config record `sign-in` (the realms in order, the
// login code, no sign-in), read and replaced as one against the version read, so two admins changing it
// at once cannot both win.
import { describe, expect, it } from 'vitest';
import type { StoredSignIn } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const SIGN_IN: StoredSignIn = {
  version: 1,
  local: { enabled: false },
  none: { role: 'operator' },
  realms: [
    { name: 'gh', label: 'GitHub', type: 'github', roles: { admin: { subjects: ['1'] } } },
    { name: 'corp', type: 'saml', enabled: false, entryPoint: 'https://idp.example.com/sso', idpCert: 'abc' },
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
    expect(back).toEqual(SIGN_IN);
    expect(record).toEqual(SIGN_IN);
  });

  it('a write against a version that moved is refused and changes nothing', () => {
    const s = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const version = s.signInConfig.version();
    expect(s.signInConfig.write(SIGN_IN, version)).toBe(true);
    expect(s.signInConfig.version()).not.toBe(version);
    expect(s.signInConfig.write({ version: 1, realms: [] }, version)).toBe(false);
    expect(s.signInConfig.read().realms.map((r) => r.name)).toEqual(['gh', 'corp']);
    s.close();
  });
});
