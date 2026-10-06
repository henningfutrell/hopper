// Instance migration 20 (issue #200, design.md "Sign-in: realms"): the password accounts are a table,
// `password_accounts`, and leave the config record `sign-in`: each password realm's `users` become its
// rows (username, argon2id hash, role) and the realm keeps its other settings. A hopper with no
// `sign-in` record gets one with the realm `password` and no accounts, so the first account is added
// in Settings → Sign-in.
import type { Db } from './db.ts';

interface Account { username: string; passwordHash: string; role: string }
type Realm = Record<string, unknown> & { name?: unknown; type?: unknown; users?: unknown };

/** The record a hopper without one starts with. */
const FIRST = { version: 1, realms: [{ name: 'password', label: 'Password', type: 'password' }] };

/** Migration 20. */
export function passwordAccountsTable(db: Db): void {
  db.exec('CREATE TABLE password_accounts (realm TEXT NOT NULL, username TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (realm, username))');
  const row = db.get("SELECT value FROM config WHERE name = 'sign-in'");
  const at = new Date().toISOString();
  if (!row) {
    db.run("INSERT INTO config (name, value, updated_at) VALUES ('sign-in', ?, ?)", JSON.stringify(FIRST), at);
    return;
  }
  const record = JSON.parse(String(row.value)) as { realms?: unknown };
  if (!Array.isArray(record.realms)) return;
  record.realms = (record.realms as Realm[]).map((r) => {
    if (r.type !== 'password') return r;
    const { users, ...rest } = r;
    for (const u of Array.isArray(users) ? users as Account[] : []) {
      db.run('INSERT INTO password_accounts (realm, username, password_hash, role) VALUES (?, ?, ?, ?)', String(r.name), u.username, u.passwordHash, u.role);
    }
    return rest;
  });
  db.run("UPDATE config SET value = ?, updated_at = ? WHERE name = 'sign-in'", JSON.stringify(record), at);
}
