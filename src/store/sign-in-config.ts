// The sign-in config (issue #200, design.md "Sign-in: realms"): the instance's config record `sign-in`
// (the realms, the login code, no sign-in) and the password accounts, rows of `password_accounts`
// (argon2id hashes only). Read as one value — each password realm with its accounts in `users` — and
// replaced as one against the version read: the accounts' table is locked for the write and the record
// written by compare-and-swap, so it holds across processes too.
import { createHash } from 'node:crypto';
import type { ConfigRecords, InstanceConfigName, SignInConfigRepository, StoredAccount, StoredRealm, StoredSignIn } from '../domain/ports.ts';
import type { UiRole } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const SIGN_IN = 'sign-in';

const versionOf = (s: StoredSignIn): string => createHash('sha256').update(JSON.stringify(s)).digest('hex');

export function createSignInConfigRepository(c: StoreContext, config: ConfigRecords<InstanceConfigName>): SignInConfigRepository {
  const read = (): StoredSignIn => {
    const accounts = new Map<string, StoredAccount[]>();
    for (const a of c.db.all('SELECT realm, username, password_hash, role FROM password_accounts ORDER BY lower(username), username')) {
      const list = accounts.get(String(a.realm)) ?? [];
      list.push({ username: String(a.username), passwordHash: String(a.password_hash), role: String(a.role) as UiRole });
      accounts.set(String(a.realm), list);
    }
    const record = (config.read(SIGN_IN) ?? { version: 1 }) as Omit<StoredSignIn, 'realms'> & { realms?: StoredRealm[] };
    const realms = (record.realms ?? []).map((r) => (r.type === 'password' ? { ...r, users: accounts.get(r.name) ?? [] } : r));
    return { ...record, realms };
  };
  return {
    read,
    version: () => versionOf(read()),
    write(next, version) {
      return c.tx(() => {
        c.db.exec('LOCK TABLE password_accounts IN EXCLUSIVE MODE');
        if (versionOf(read()) !== version) return false;
        const record = { ...next, realms: next.realms.map(({ users: _users, ...r }) => r) };
        if (!config.write(SIGN_IN, record, config.version(SIGN_IN))) return false;
        c.db.exec('DELETE FROM password_accounts');
        for (const r of next.realms) {
          for (const u of r.users ?? []) {
            c.db.run('INSERT INTO password_accounts (realm, username, password_hash, role) VALUES (?, ?, ?, ?)', r.name, u.username, u.passwordHash, u.role);
          }
        }
        return true;
      });
    },
  };
}
