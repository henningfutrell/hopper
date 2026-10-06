// Migration 20 (issue #200): the password accounts are a table. Each password realm's `users` in the
// config record `sign-in` become rows of `password_accounts` (username, argon2id hash, role), and leave
// the record; every other realm and setting stays as it was. A hopper with no `sign-in` record gets one
// with the realm `password` and no accounts, ready for its first account in Settings → Sign-in.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

/** Store a `sign-in` record (or none) at version 19, migrate to 20, read the record and the accounts back. */
function migrateFrom19(record?: unknown) {
  const url = t.url();
  const raw = t.at(url, 19);
  if (record !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('sign-in', ?, 'x')", JSON.stringify(record));
  raw.close();
  t.at(url, 20).close();
  const after = openDb(url);
  const row = after.get("SELECT value FROM config WHERE name = 'sign-in'");
  const accounts = after.all('SELECT realm, username, password_hash, role FROM password_accounts ORDER BY realm, username');
  after.close();
  return { record: row ? JSON.parse(String(row.value)) as unknown : undefined, accounts };
}

describe('migration 20: password accounts → password_accounts', () => {
  it('each password realm\'s accounts become rows and leave the record; the rest stays', () => {
    const r = migrateFrom19({
      version: 1,
      local: { enabled: false },
      none: { role: 'viewer' },
      realms: [
        { name: 'staff', label: 'Staff', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }, { username: 'bea', passwordHash: HASH, role: 'admin' }] },
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', enabled: false, roles: { defaultRole: 'viewer' } },
        { name: 'more', type: 'password', users: [] },
      ],
    });
    expect(r.record).toEqual({
      version: 1,
      local: { enabled: false },
      none: { role: 'viewer' },
      realms: [
        { name: 'staff', label: 'Staff', type: 'password' },
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', enabled: false, roles: { defaultRole: 'viewer' } },
        { name: 'more', type: 'password' },
      ],
    });
    expect(r.accounts).toEqual([
      { realm: 'staff', username: 'ada', password_hash: HASH, role: 'operator' },
      { realm: 'staff', username: 'bea', password_hash: HASH, role: 'admin' },
    ]);
  });

  it('a record with no realms stays as it is', () => {
    expect(migrateFrom19({ version: 1 })).toEqual({ record: { version: 1 }, accounts: [] });
  });

  it('no record: one with the realm password and no accounts', () => {
    expect(migrateFrom19()).toEqual({ record: { version: 1, realms: [{ name: 'password', label: 'Password', type: 'password' }] }, accounts: [] });
  });
});
