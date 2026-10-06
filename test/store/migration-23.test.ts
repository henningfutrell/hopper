// Migration 23 (issue #214): a github realm signs in through the hopper's GitHub App by the device flow,
// with the app's public client id and no secret, and every hopper offers it: one without a github realm
// gets one, `github`, with no role rules (the first person to sign in with it becomes admin, issue #239). A stored github realm made for an OAuth app of its own
// (clientId, clientSecret, webUrl, apiUrl) keeps its name, label, on/off and role rules, and loses the
// app settings and the secret: the hopper's app (or the one the environment names) is what it uses now.
// Every other realm and setting stays as it was.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function migrateFrom22(record: unknown): unknown {
  const url = t.url();
  const raw = t.at(url, 22);
  raw.run("INSERT INTO config (name, value, updated_at) VALUES ('sign-in', ?, 'x') ON CONFLICT (name) DO UPDATE SET value = excluded.value", JSON.stringify(record));
  raw.close();
  t.at(url, 23).close();
  const after = openDb(url);
  const row = after.get("SELECT value FROM config WHERE name = 'sign-in'");
  after.close();
  return row ? JSON.parse(String(row.value)) as unknown : undefined;
}

describe('migration 23: a github realm is the hopper\'s GitHub App, by the device flow', () => {
  it('drops an OAuth app\'s settings and secret from each github realm; the rest stays', () => {
    const roles = { admin: { usernames: ['octo'] }, defaultRole: 'viewer' };
    expect(migrateFrom22({
      version: 1,
      local: { enabled: false },
      realms: [
        { name: 'gh', label: 'GitHub', type: 'github', clientId: 'g', clientSecret: 's', webUrl: 'https://github.com', apiUrl: 'https://api.github.com', enabled: false, roles },
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 'x', roles: {} },
      ],
    })).toEqual({
      version: 1,
      local: { enabled: false },
      realms: [
        { name: 'gh', label: 'GitHub', type: 'github', enabled: false, roles },
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 'x', roles: {} },
      ],
    });
  });

  it('a hopper without a github realm gets one, after its realms', () => {
    expect(migrateFrom22({ version: 1, realms: [{ name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c' }] })).toEqual({
      version: 1,
      realms: [
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c' },
        { name: 'github', label: 'GitHub', type: 'github' },
      ],
    });
  });
});
