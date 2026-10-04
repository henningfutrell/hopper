// The ssh targets the UI may attach (issue #18): the Host aliases of ~/.ssh/config, never a typed
// destination. Wildcard and negated patterns are not hosts; Include is followed (relative to
// ~/.ssh, globs expanded); what cannot be read is a note, not an error.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSshTargets } from '../../src/machines/index.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-ssh-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, text: string): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};

describe('readSshTargets', () => {
  it('lists every Host alias once, in file order; wildcards, negations and Match blocks are not targets', () => {
    const config = write('config', [
      '# my hosts',
      'Host laptop',
      '  HostName 192.0.2.10',
      'host desk desk-2   # two aliases on one line',
      'Host *.lan !nope gpu?',
      'Host=bastion',
      'Match host foo',
      '  User x',
      'Host laptop',
      'Host *',
      '  ServerAliveInterval 30',
    ].join('\n'));
    expect(readSshTargets(config)).toEqual({ targets: ['laptop', 'desk', 'desk-2', 'bastion'], notes: [] });
  });

  it('follows Include: a plain file relative to the config directory, and a glob', () => {
    write('conf.d/a.conf', 'Host alpha\n');
    write('conf.d/b.conf', 'Host beta\n');
    write('extra', 'Host gamma\n');
    const config = write('config', `Include extra\nHost laptop\nInclude ${join(dir, 'conf.d')}/*.conf\n`);
    expect(readSshTargets(config).targets).toEqual(['gamma', 'laptop', 'alpha', 'beta']);
  });

  it('an Include that matches nothing, and a missing config, are notes', () => {
    const config = write('config', 'Include missing.conf\nHost laptop\n');
    expect(readSshTargets(config)).toEqual({ targets: ['laptop'], notes: [expect.stringContaining('missing.conf')] });
    expect(readSshTargets(join(dir, 'nope'))).toEqual({ targets: [], notes: [expect.stringContaining('no ssh config')] });
  });

  it('an Include loop stops', () => {
    const config = write('config', 'Host laptop\nInclude config\n');
    expect(readSshTargets(config).targets).toEqual(['laptop']);
  });
});
