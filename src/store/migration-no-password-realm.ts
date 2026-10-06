// Instance migration 22 (issue #237, design.md "Sign-in: realms"): the password user realm is gone. Each
// password realm leaves the config record `sign-in`, the table `password_accounts` goes, and so do the
// identity links of those realms — a realm added later under the same name must not sign in as their
// users. The users and their work stay. A sign-in config left with no way in (no realm that is on, the
// login code off, no sign-in off) turns the login code on: the login code is the first sign-in.
import type { Db } from './db.ts';

type Realm = Record<string, unknown> & { name?: unknown; type?: unknown; enabled?: unknown };
interface SignInRecord { local?: { enabled?: unknown }; none?: unknown; realms?: unknown }

/** Migration 22. */
export function noPasswordRealm(db: Db): void {
  db.exec('DROP TABLE IF EXISTS password_accounts');
  const row = db.get("SELECT value FROM config WHERE name = 'sign-in'");
  if (!row) return;
  const record = JSON.parse(String(row.value)) as SignInRecord;
  if (!Array.isArray(record.realms)) return;
  const realms = record.realms as Realm[];
  const gone = realms.filter((r) => r.type === 'password').map((r) => String(r.name));
  if (gone.length === 0) return;
  for (const name of gone) db.run('DELETE FROM user_identities WHERE realm = ?', name);
  record.realms = realms.filter((r) => r.type !== 'password');
  const wayIn = (record.realms as Realm[]).some((r) => r.enabled !== false) || record.local?.enabled !== false || record.none !== undefined;
  if (!wayIn) record.local = { enabled: true };
  db.run("UPDATE config SET value = ?, updated_at = ? WHERE name = 'sign-in'", JSON.stringify(record), new Date().toISOString());
}
