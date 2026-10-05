// Migration 12 (issue #112): the rename to hopper renames the herdr session the hopper's own units run
// (`hopper`, was `job-hopper`), and with it the default `session` of herdr-claude and of an ssh-attached
// machine. plugins.yaml keeps meaning what it meant: an ssh machine that named no session runs its jobs in
// the session its own unit runs there, `job-hopper`, so it is named; a herdr-claude instance that named
// the old local session follows the local unit to the new one.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const BEFORE = `# my plugins
version: 1
executors:
  - name: herdr-claude
    plugin: herdr-claude
    options:
      session: job-hopper
  - name: other-herdr
    plugin: herdr-claude
    options: { session: mine, trustWorkdir: true }
attachedMachines:
  - { name: box, ssh: box, lanes: 2 }
  - name: pinned
    ssh: pinned
    session: own-session
    lanes: 1
  - { name: laptop, client: { tokenEnv: CLIENT_TOKEN_LAPTOP }, lanes: 1 }
`;

function migrate(text: string | undefined): string | undefined {
  const url = t.url();
  t.open(url).close();
  const raw = openDb(url);
  if (text !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')", text);
  raw.run('UPDATE schema_version SET version = 11');
  raw.close();
  t.open(url).close();
  const after = openDb(url);
  const row = after.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  after.close();
  return row?.text as string | undefined;
}

describe('migration 12 (the herdr session renamed)', () => {
  it('names job-hopper on ssh machines that named no session, and drops it from herdr-claude', () => {
    const text = migrate(BEFORE)!;
    const doc = parse(text) as { executors: { options?: Record<string, unknown> }[]; machines: { name: string; options: Record<string, unknown> }[] };
    expect(doc.executors[0]).toEqual({ name: 'herdr-claude', plugin: 'herdr-claude' });
    expect(doc.executors[1]!.options).toEqual({ session: 'mine', trustWorkdir: true });
    // Migration 15 runs after: each attached machine is a machines: instance, its fields its options (issue #74).
    expect(doc.machines.slice(1).map((m) => [m.name, m.options.session])).toEqual([['box', 'job-hopper'], ['pinned', 'own-session'], ['laptop', undefined]]);
    expect(text.startsWith('# my plugins\n')).toBe(true);
  });

  it('no plugins.yaml, or nothing to change: left as it is', () => {
    expect(migrate(undefined)).toBeUndefined();
    const plain = 'version: 1\nexecutors:\n  - { name: herdr-claude, plugin: herdr-claude }\n';
    expect(migrate(plain)).toBe(plain);
  });
});
