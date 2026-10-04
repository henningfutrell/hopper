// A machine edit (issue #18) rewrites one entry of plugins.yaml `attachedMachines:` and no other
// byte: entries written as block maps stay block maps, an empty `[]` becomes a list, and the last
// entry removed leaves `[]` (an empty key would be null, which the file schema refuses).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { applyMachineEdit, type MachineEditContext } from '../../src/plugins/attached-edit.ts';
import { pluginsFileVersion } from '../../src/plugins/plugins-file.ts';
import { useTempDirs } from './support.ts';

const temp = useTempDirs();

function setup(text: string): { ctx: MachineEditContext; path: string; version: string } {
  const path = join(temp(), 'plugins.yaml');
  writeFileSync(path, text, { mode: 0o600 });
  return {
    path,
    version: pluginsFileVersion(text),
    ctx: {
      path, machineName: 'local', executors: ['herdr-claude', 'test'],
      sshTargets: () => ({ targets: ['laptop', 'desk'], notes: [] }),
      resolveHerdrBin: async () => '/h/bin/herdr',
      inUse: () => [],
    },
  };
}

const BLOCK = `version: 1
attachedMachines:
  # first
  - name: desk
    ssh: desk
    lanes: 1
    herdrBin: /usr/bin/herdr
  - name: spare   # spare one
    ssh: desk
    lanes: 1
# tail comment
notifiers: []
`;

describe('applyMachineEdit on block-style entries', () => {
  it('add appends a block map at the same indentation; the rest is unchanged', async () => {
    const { ctx, path, version } = setup(BLOCK);
    expect(await applyMachineEdit({ action: 'add', name: 'laptop', ssh: 'laptop', lanes: 2, version }, ctx)).toEqual({ ok: true, changed: true });
    const text = readFileSync(path, 'utf8');
    expect(text).toBe(BLOCK.replace('# tail comment', '  - name: laptop\n    ssh: laptop\n    lanes: 2\n    herdrBin: /h/bin/herdr\n# tail comment'));
  });

  it('edit rewrites only that entry', async () => {
    const { ctx, path, version } = setup(BLOCK);
    expect((await applyMachineEdit({ action: 'edit', name: 'spare', lanes: 3, version }, ctx)).ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith(BLOCK.slice(0, BLOCK.indexOf('  - name: spare')))).toBe(true);
    expect(text.endsWith('# tail comment\nnotifiers: []\n')).toBe(true);
    expect(parse(text).attachedMachines[1]).toEqual({ name: 'spare', ssh: 'desk', lanes: 3 });
  });

  it('remove deletes every line of that entry', async () => {
    const { ctx, path, version } = setup(BLOCK);
    expect((await applyMachineEdit({ action: 'remove', name: 'desk', version }, ctx)).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(BLOCK.replace('  - name: desk\n    ssh: desk\n    lanes: 1\n    herdrBin: /usr/bin/herdr\n', ''));
  });
});

describe('applyMachineEdit on an empty or last list', () => {
  it('`attachedMachines: []` becomes a list with the one entry', async () => {
    const { ctx, path, version } = setup('version: 1\nattachedMachines: []\nnotifiers: []\n');
    expect((await applyMachineEdit({ action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, version }, ctx)).ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('notifiers: []\n')).toBe(true);
    expect(parse(text).attachedMachines).toEqual([{ name: 'laptop', ssh: 'laptop', lanes: 1, herdrBin: '/h/bin/herdr' }]);
  });

  it('removing the last entry leaves `attachedMachines: []`', async () => {
    const text = 'version: 1\nattachedMachines:\n  - { name: desk, ssh: desk, lanes: 1 }\nnotifiers: []\n';
    const { ctx, path, version } = setup(text);
    expect((await applyMachineEdit({ action: 'remove', name: 'desk', version }, ctx)).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('version: 1\nattachedMachines: []\nnotifiers: []\n');
  });

  it('the file changing while herdr is resolved: 409, nothing written over it', async () => {
    const { ctx, path, version } = setup('version: 1\n');
    ctx.resolveHerdrBin = async () => { writeFileSync(path, 'version: 1\n# meanwhile\n'); return '/h/bin/herdr'; };
    expect(await applyMachineEdit({ action: 'add', name: 'laptop', ssh: 'laptop', lanes: 1, version }, ctx)).toMatchObject({ ok: false, code: 'conflict' });
    expect(readFileSync(path, 'utf8')).toBe('version: 1\n# meanwhile\n');
  });
});
