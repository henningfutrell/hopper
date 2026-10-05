// Migration 15 (issue #74): attached machines are machine-source instances. plugins.yaml `machines:`
// becomes a list: the machine source's one instance (the built-in `local` when the section was
// absent), then each `attachedMachines:` entry as an instance of the plugin named by its connection —
// `ssh`, `docker` or `client` — with the entry's fields as its options. `attachedMachines:` goes.
// Comments and every other section stay. Persisted state is the user's: nothing configured is lost.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

/** The store as migration 14 left it, holding `text` as plugins.yaml; then opened, so migration 15 runs. */
function migrated(text: string): string | undefined {
  const url = t.url();
  t.at(url, 16).close();
  const raw = openDb(url);
  raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')", text);
  raw.run('UPDATE schema_version SET version = 14');
  raw.close();
  t.at(url, 16).close();
  const after = openDb(url);
  const row = after.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  after.close();
  return row ? String(row.text) : undefined;
}

describe('migration 15 (attached machines are machine-source instances)', () => {
  it('the machine source and every attached machine become one machines: list; comments and other sections stay', () => {
    const text = migrated([
      'version: 1',
      '# the owner\'s note',
      'executors: [ { name: test, plugin: test } ]',
      'machines: { name: here, plugin: local, options: { lanes: 2 } }',
      'attachedMachines:',
      '  # the desk',
      '  - { name: desk, label: the desk, ssh: desk, lanes: 1, executors: [test], herdrBin: /usr/bin/herdr, hostKey: ssh-ed25519 AAAA }',
      '  - { name: box, docker: box, lanes: 2, executors: [command] }',
      '  - { name: far, client: { tokenEnv: FAR_TOKEN }, lanes: 1 }',
      '',
    ].join('\n'))!;
    expect(text).toContain('# the owner\'s note');
    expect(text).toMatch(/# the desk\n.*name: desk/);
    const doc = parse(text);
    expect(doc.attachedMachines).toBeUndefined();
    expect(doc.executors).toEqual([{ name: 'test', plugin: 'test' }]);
    expect(doc.machines).toEqual([
      { name: 'here', plugin: 'local', options: { lanes: 2 } },
      { name: 'desk', plugin: 'ssh', options: { label: 'the desk', ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr', hostKey: 'ssh-ed25519 AAAA' } },
      { name: 'box', plugin: 'docker', options: { docker: 'box', lanes: 2, executors: ['command'] } },
      { name: 'far', plugin: 'client', options: { tokenEnv: 'FAR_TOKEN', lanes: 1 } },
    ]);
  });

  it('no machines: section: the built-in local comes first, so this machine is not lost', () => {
    const doc = parse(migrated('version: 1\nattachedMachines:\n  - { name: desk, ssh: desk, lanes: 1 }\n')!);
    expect(doc.machines).toEqual([
      { name: 'local', plugin: 'local', options: { lanes: 4 } },
      { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1 } },
    ]);
  });

  it('a machines: map and no attached machines: a list of one', () => {
    const doc = parse(migrated('version: 1\nmachines: { name: local, plugin: local, options: { lanes: 3 } }\n')!);
    expect(doc.machines).toEqual([{ name: 'local', plugin: 'local', options: { lanes: 3 } }]);
  });

  it('a document that names neither, or does not parse, is left as it is', () => {
    expect(migrated('version: 1\nexecutors: [ { name: test, plugin: test } ]\n')).toBe('version: 1\nexecutors: [ { name: test, plugin: test } ]\n');
    expect(migrated('version: 1\nmachines: [\n')).toBe('version: 1\nmachines: [\n');
  });
});
