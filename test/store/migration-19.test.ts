// Migration 19 (issue #198): no config files and no YAML. The instance's auth.yaml document becomes
// the config record `sign-in` (the document's value), and the config document table goes. A
// document that does not parse stops the migration, nothing changed, rather than being dropped.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { migrateInstance } from '../../src/store/migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$9b3MzyRk2xr6m1nZQ1kq4cXf3A2c5o8gV7x0Lr0bq0s';

function at18(auth?: string): string {
  const url = t.url();
  const raw = t.at(url, 18);
  if (auth !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('auth.yaml', ?, 'x')", auth);
  raw.close();
  return url;
}

function records(url: string) {
  const raw = openDb(url);
  const out = Object.fromEntries(raw.all('SELECT name, value FROM config ORDER BY name').map((r) => [r.name, JSON.parse(String(r.value)) as unknown]));
  const documents = raw.get("SELECT to_regclass('config_documents') AS t")!.t;
  raw.close();
  return { records: out, documents };
}

describe('migration 19: auth.yaml becomes the sign-in config record', () => {
  it('every realm and setting comes across; the document table is gone', () => {
    const url = at18([
      '# sign-in',
      'version: 1',
      'local: { enabled: false }',
      'realms:',
      `  - { name: password, label: Password, type: password, users: [ { username: ada, passwordHash: "${HASH}", role: operator } ] }`,
      '  - { name: gh, type: github, clientId: g, clientSecretEnv: GH, enabled: false }',
      '',
    ].join('\n'));
    t.at(url, 19).close();
    expect(records(url)).toEqual({
      records: {
        'sign-in': {
          version: 1,
          local: { enabled: false },
          realms: [
            { name: 'password', label: 'Password', type: 'password', users: [{ username: 'ada', passwordHash: HASH, role: 'operator' }] },
            { name: 'gh', type: 'github', clientId: 'g', clientSecretEnv: 'GH', enabled: false },
          ],
        },
      },
      documents: null,
    });
  });

  it('no auth.yaml: no record (the login code only, as before)', () => {
    const url = at18();
    t.at(url, 19).close();
    expect(records(url)).toEqual({ records: {}, documents: null });
  });

  it('an auth.yaml that does not parse stops the migration: the document stays', () => {
    const url = at18('realms: [\n');
    const raw = openDb(url);
    expect(() => migrateInstance(raw, 19)).toThrow(/auth\.yaml does not parse/);
    expect(raw.get("SELECT text FROM config_documents WHERE name = 'auth.yaml'")!.text).toBe('realms: [\n');
    raw.close();
  });
});
