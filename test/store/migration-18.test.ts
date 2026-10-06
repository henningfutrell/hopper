// Migration 18 (issue #185): sign-in is realms. A stored auth.yaml's `password` section becomes the
// first realm, `password`, of type password, and its `providers` follow as realms, in their order,
// comments kept. Identity links and stored sessions name their realm where they named a provider, so
// every link and session keeps working.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

/** Store auth.yaml, a session and an identity link at version 17, migrate to 18, read them back. */
function migrateFrom17(o: { auth?: string; identity?: Record<string, unknown> }) {
  const url = t.url();
  const raw = t.at(url, 17);
  if (o.auth !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('auth.yaml', ?, 'x')", o.auth);
  if (o.identity) {
    raw.run("INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES ('h', '2099-01-01', 'admin', ?, 'owner')", JSON.stringify(o.identity));
    raw.run("INSERT INTO user_identities (provider, subject, user_id) VALUES (?, ?, 'owner')", String(o.identity.provider), String(o.identity.subject));
  }
  raw.close();
  t.at(url, 18).close();
  const after = openDb(url);
  const auth = after.get("SELECT text FROM config_documents WHERE name = 'auth.yaml'");
  const session = after.get("SELECT identity FROM ui_sessions WHERE token_hash = 'h'");
  const links = after.all('SELECT realm, subject, user_id FROM user_identities');
  after.close();
  return { auth: auth ? String(auth.text) : undefined, identity: session ? JSON.parse(String(session.identity)) as unknown : undefined, links };
}

describe('migration 18: auth.yaml providers and password → realms', () => {
  it('password sign-in becomes the first realm, the providers follow in order; comments and other fields kept', () => {
    const before = [
      '# sign-in',
      'version: 1',
      'local: { enabled: false }',
      'none: { role: viewer }',
      'password:',
      '  users:',
      `    - { username: ada, passwordHash: "${HASH}", role: operator }`,
      'providers:',
      '  # the company IdP',
      '  - { name: corp, type: oidc, issuer: "https://idp.example.com", clientId: c, roles: { defaultRole: viewer } }',
      '  - { name: gh, type: github, clientId: g, clientSecretEnv: GH }',
      '',
    ].join('\n');
    const after = migrateFrom17({ auth: before }).auth!;
    expect(after).toContain('# sign-in');
    expect(after).toContain('# the company IdP');
    expect(parse(after)).toEqual({
      version: 1,
      local: { enabled: false },
      none: { role: 'viewer' },
      realms: [
        { name: 'password', label: 'Password', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }] },
        { name: 'corp', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'c', roles: { defaultRole: 'viewer' } },
        { name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GH' },
      ],
    });
  });

  it('providers only, or password only', () => {
    expect(parse(migrateFrom17({ auth: 'version: 1\nproviders: [{ name: gh, type: github, clientId: g, clientSecretEnv: GH }]\n' }).auth!))
      .toEqual({ version: 1, realms: [{ name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GH' }] });
    expect(parse(migrateFrom17({ auth: 'version: 1\npassword: { users: [] }\n' }).auth!))
      .toEqual({ version: 1, realms: [{ name: 'password', label: 'Password', type: 'password', users: [] }] });
  });

  it('a document with neither, no document, and one that does not parse are left as they are', () => {
    expect(migrateFrom17({ auth: 'version: 1\nlocal: { enabled: true }\n' }).auth).toBe('version: 1\nlocal: { enabled: true }\n');
    expect(migrateFrom17({}).auth).toBeUndefined();
    expect(migrateFrom17({ auth: 'providers: [\n' }).auth).toBe('providers: [\n');
  });

  it('a stored session and an identity link name their realm', () => {
    const r = migrateFrom17({ identity: { provider: 'corp', subject: 's-1', email: 'a@example.com', groups: ['g'] } });
    expect(r.identity).toEqual({ realm: 'corp', subject: 's-1', email: 'a@example.com', groups: ['g'] });
    expect(r.links).toEqual([{ realm: 'corp', subject: 's-1', user_id: 'owner' }]);
  });
});
