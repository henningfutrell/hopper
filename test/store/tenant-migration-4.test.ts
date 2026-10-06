// Tenant migration 4 (issue #198): no config files and no YAML. A user's plugins.yaml and rules.md
// documents become the config records `plugins` (the document's value) and `rules` (its text), and
// the config document table goes. Persisted state is the user's: every value comes across; a
// document that does not parse stops the migration, nothing changed, rather than being dropped.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at3(docs: Record<string, string>): Db {
  const raw = t.tenantAt(t.url(), 3);
  for (const [name, text] of Object.entries(docs)) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES (?, ?, 'x')", name, text);
  return raw;
}

const records = (raw: Db) => Object.fromEntries(raw.all('SELECT name, value FROM config ORDER BY name').map((r) => [r.name, JSON.parse(String(r.value)) as unknown]));
const table = (raw: Db, name: string) => raw.get('SELECT to_regclass(?) AS t', name)!.t;

describe('tenant migration 4: plugins.yaml and rules.md become config records', () => {
  it('the plugins document\'s value and the rules text, every field kept; the document table is gone', () => {
    const raw = at3({
      'plugins.yaml': [
        '# my plugins',
        'version: 1',
        'machines:',
        '  - { name: here, plugin: local, options: { lanes: 2 } }',
        'escalationLevels:',
        '  - { name: opus, plugin: claude-cli, options: { machine: here, model: opus, bin: /opt/claude } }',
        'routing:',
        '  - { name: big, when: { labels: [big] }, set: { machine: here } }',
        '',
      ].join('\n'),
      'rules.md': '# rules\n\nbe kind\n',
    });
    migrateTenant(raw, 4);
    expect(records(raw)).toEqual({
      plugins: {
        version: 1,
        machines: [{ name: 'here', plugin: 'local', options: { lanes: 2 } }],
        escalationLevels: [{ name: 'opus', plugin: 'claude-cli', options: { machine: 'here', model: 'opus', bin: '/opt/claude' } }],
        routing: [{ name: 'big', when: { labels: ['big'] }, set: { machine: 'here' } }],
      },
      rules: '# rules\n\nbe kind\n',
    });
    expect(table(raw, 'config_documents')).toBeNull();
    raw.close();
  });

  it('no documents: no records, and the table is there for the first boot to fill', () => {
    const raw = at3({});
    migrateTenant(raw, 4);
    expect(records(raw)).toEqual({});
    expect(table(raw, 'config')).not.toBeNull();
    raw.close();
  });

  it('a plugins.yaml that does not parse stops the migration: the document stays, nothing is lost', () => {
    const raw = at3({ 'plugins.yaml': 'version: 1\nexecutors: [ oops\n' });
    expect(() => migrateTenant(raw, 4)).toThrow(/plugins\.yaml does not parse/);
    expect(raw.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'")!.text).toBe('version: 1\nexecutors: [ oops\n');
    raw.close();
  });
});
