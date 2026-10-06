// Migration 22 (issue #237): the password user realm is gone. Each password realm leaves the config
// record `sign-in`, the table `password_accounts` goes, and so do the identity links of those realms
// (a realm added later under the same name must not sign in as their users). The users and their work
// stay. A sign-in config left with no way in turns the login code on.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const signInRecord = (url: string): unknown => {
  const db = openDb(url);
  const row = db.get("SELECT value FROM config WHERE name = 'sign-in'");
  db.close();
  return JSON.parse(String(row!.value));
};

/** The realm migration 23 gives every hopper (issue #214). */
const GITHUB = { name: 'github', label: 'GitHub', type: 'github' };

describe('migration 22: no password user realm', () => {
  it('removes the password realms, their accounts and their links; other realms, users and links stay', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock(), version: 21 }).close();
    const raw = t.at(url, 21);
    const record = { version: 1, local: { enabled: true }, realms: [
      { name: 'password', label: 'Password', type: 'password' },
      { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', roles: {} },
    ] };
    raw.run("UPDATE config SET value = ? WHERE name = 'sign-in'", JSON.stringify(record));
    raw.run("INSERT INTO password_accounts (realm, username, password_hash, role) VALUES ('password', 'ada', '$argon2id$x', 'admin')");
    raw.run("INSERT INTO user_identities (realm, subject, user_id) VALUES ('password', 'ada', 'admin'), ('corp', 'sub-1', 'admin')");
    raw.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list().map((u) => u.id)).toEqual(['admin']);
    expect(instance.identities.userOf('password', 'ada')).toBeUndefined();
    expect(instance.identities.userOf('corp', 'sub-1')).toBe('admin');
    instance.close();
    // Migration 23 (issue #214) then gives every hopper the github realm.
    expect(signInRecord(url)).toEqual({ version: 1, local: { enabled: true }, realms: [record.realms[1], GITHUB] });
    const db = openDb(url);
    expect(db.get("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'password_accounts'")).toBeUndefined();
    db.close();
  });

  it('turns the login code on when the password realm was the only way in', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock(), version: 21 }).close();
    const raw = t.at(url, 21);
    raw.run("UPDATE config SET value = ? WHERE name = 'sign-in'", JSON.stringify({ version: 1, local: { enabled: false }, realms: [{ name: 'password', type: 'password' }] }));
    raw.close();
    openInstanceStore({ url, clock: fixedClock() }).close();
    expect(signInRecord(url)).toEqual({ version: 1, local: { enabled: true }, realms: [GITHUB] });
  });

  it('leaves the login code off when another realm that is on is a way in', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock(), version: 21 }).close();
    const raw = t.at(url, 21);
    const corp = { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c' };
    raw.run("UPDATE config SET value = ? WHERE name = 'sign-in'", JSON.stringify({ version: 1, local: { enabled: false }, realms: [{ name: 'password', type: 'password' }, corp] }));
    raw.close();
    openInstanceStore({ url, clock: fixedClock() }).close();
    expect(signInRecord(url)).toEqual({ version: 1, local: { enabled: false }, realms: [corp, GITHUB] });
  });
});
