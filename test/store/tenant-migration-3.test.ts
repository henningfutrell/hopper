// Tenant migration 3 (issue #174): a part that runs on a machine names it; this machine is no default.
// A claude-cli escalation level or a claude-plan usage source that named none ran here, on the `local`
// machine: it names that machine now. Comments and everything else in the document stay.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { testPostgres } from '../support/database.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

/** Store `plugins` in owner's user schema at tenant version 2, migrate, and read it back. */
function migrateFrom2(plugins: string): string {
  const url = t.url();
  t.open(url).close();
  const owner = `"${new URL(url).searchParams.get('schema')!}_u_owner"`;
  const raw = openDb(testPostgres());
  raw.run(`INSERT INTO ${owner}.config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')
    ON CONFLICT (name) DO UPDATE SET text = excluded.text`, plugins);
  raw.run(`UPDATE ${owner}.schema_version SET version = 2`);
  const instance = openInstanceStore({ url, clock: fixedClock() });
  instance.userStore(instance.users.owner()).close();
  instance.close();
  const text = String(raw.get(`SELECT text FROM ${owner}.config_documents WHERE name = 'plugins.yaml'`)!.text);
  raw.close();
  return text;
}

describe('tenant migration 3: a claude-cli level or claude-plan source without a machine names the local machine', () => {
  it('names the `local` machine where none is named; a named machine and other plugins stay; comments stay', () => {
    const after = migrateFrom2([
      '# my plugins',
      'version: 1',
      'machines:',
      '  - { name: here, plugin: local, options: { lanes: 2 } }',
      '  - { name: box, plugin: ssh, options: { ssh: box } }',
      'escalationLevels:',
      '  - { name: opus, plugin: claude-cli, options: { model: opus } }',
      '  - { name: fable, plugin: claude-cli }',
      '  - { name: far, plugin: claude-cli, options: { machine: box } }',
      '  - { name: api, plugin: anthropic-api }',
      'usageSources:',
      '  - { name: claude, plugin: claude-plan, options: { bin: claude, intervalSeconds: 600 } }',
      '',
    ].join('\n'));
    expect(after).toContain('# my plugins');
    expect(parse(after)).toMatchObject({
      escalationLevels: [
        { name: 'opus', plugin: 'claude-cli', options: { model: 'opus', machine: 'here' } },
        { name: 'fable', plugin: 'claude-cli', options: { machine: 'here' } },
        { name: 'far', plugin: 'claude-cli', options: { machine: 'box' } },
        { name: 'api', plugin: 'anthropic-api' },
      ],
      usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: 'claude', intervalSeconds: 600, machine: 'here' } }],
    });
  });

  it('with no `machines:` section the built-in `local` machine is named', () => {
    const after = migrateFrom2('version: 1\nescalationLevels:\n  - { name: opus, plugin: claude-cli }\n');
    expect(parse(after).escalationLevels).toEqual([{ name: 'opus', plugin: 'claude-cli', options: { machine: 'local' } }]);
  });

  it('with no local machine (the container) nothing is named: the owner picks one; a document that does not parse stays', () => {
    const none = 'version: 1\nmachines:\n  - { name: box, plugin: ssh, options: { ssh: box } }\nescalationLevels:\n  - { name: opus, plugin: claude-cli }\n';
    expect(migrateFrom2(none)).toBe(none);
    expect(migrateFrom2('version: 1\nescalationLevels: [ oops\n')).toBe('version: 1\nescalationLevels: [ oops\n');
  });
});
