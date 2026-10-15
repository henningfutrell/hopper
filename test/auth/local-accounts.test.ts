// Local accounts (issue #1380, src/auth/local-accounts.ts): a password is kept as a scrypt hash, salted, never the password;
// the form realm signs in an account by its email in any case, with the account's own role, and refuses an unknown email
// or a wrong password alike. The sign-in config keeps the realm name for itself.
import { describe, expect, it } from 'vitest';
import { loadSignInConfig } from '../../src/auth/config.ts';
import { roleIn } from '../../src/auth/index.ts';
import { accountIdentity, createLocalAccountsRealm, hashPassword, LOCAL_ACCOUNTS_REALM, verifyPassword } from '../../src/auth/local-accounts.ts';
import type { LocalAccount } from '../../src/domain/ports.ts';

const PASSWORD = 'correct horse battery staple';

const store = (accounts: LocalAccount[]) => ({
  get: (email: string) => accounts.find((a) => a.email === email.toLowerCase()),
  list: () => accounts,
});

describe('local account passwords', () => {
  it('a hash is salted scrypt, never the password, and checks only its own password', async () => {
    const [a, b] = [await hashPassword(PASSWORD), await hashPassword(PASSWORD)];
    expect(a).toMatch(/^scrypt\$65536\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(a, PASSWORD)).toBe(true);
    expect(await verifyPassword(a, `${PASSWORD}!`)).toBe(false);
    expect(await verifyPassword(a, '')).toBe(false);
    expect(await verifyPassword('$argon2id$v=19$whatever', PASSWORD)).toBe(false);
    expect(await verifyPassword('scrypt$99999999$8$1$c2FsdA$a2V5', PASSWORD)).toBe(false);
  });
});

describe('the local accounts realm', () => {
  it('signs in an account by its email, in any case, with its own role; refuses a wrong password or an unknown email', async () => {
    const accounts = store([{ email: 'ada@example.com', role: 'operator', passwordHash: await hashPassword(PASSWORD), createdAt: '2026-10-15T00:00:00.000Z' }]);
    const realm = createLocalAccountsRealm(accounts);
    expect(await realm.check(' Ada@Example.com ', PASSWORD)).toEqual({ ok: true, role: 'operator', who: { realm: LOCAL_ACCOUNTS_REALM, subject: 'ada@example.com', email: 'ada@example.com', username: 'ada@example.com', groups: [] } });
    expect(await realm.check('ada@example.com', 'not the password')).toEqual({ ok: false });
    expect(await realm.check('bea@example.com', PASSWORD)).toEqual({ ok: false });
    expect(await realm.check('not an email', PASSWORD)).toEqual({ ok: false });
  });

  it('its identity has the role of its account while the account is there, whatever the sign-in config', async () => {
    const config = loadSignInConfig({ version: 1, realms: [] });
    const ada = accountIdentity({ email: 'ada@example.com' });
    expect(roleIn(config, ada, store([{ email: 'ada@example.com', role: 'admin', passwordHash: 'x', createdAt: '' }]))).toBe('admin');
    expect(roleIn(config, ada, store([]))).toBeNull();
    expect(roleIn(config, ada)).toBeNull();
  });

  it('no realm of the sign-in config takes its name', () => {
    expect(() => loadSignInConfig({ version: 1, realms: [{ name: LOCAL_ACCOUNTS_REALM, type: 'github' }] })).toThrow(/realms\.0\.name/);
  });
});
