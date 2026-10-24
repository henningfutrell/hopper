// A tar of files with long repository paths (issue #2716, src/sandbox/socket-http.ts): a step schedule's files keep their
// paths in the sandbox, so a name over 100 bytes goes in two, its folders in the ustar prefix. GNU tar reads it whole.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesTar, tarNameParts } from '../../src/sandbox/socket-http.ts';

const LONG = `${'workflows/web-app-development/phrase-drill/offsite-backup/'.repeat(2)}conf/settings-for-the-offsite-backup-step.json`;

describe('a tar of long paths (issue #2716)', () => {
  it('a short name has no prefix; a long one splits at a folder', () => {
    expect(tarNameParts('a/b.sh')).toEqual(['', 'a/b.sh']);
    const [prefix, name] = tarNameParts(LONG);
    expect(`${prefix}/${name}`).toBe(LONG);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(100);
    expect(() => tarNameParts(`${'x'.repeat(200)}/y`)).toThrow(/too long for a tar/);
  });

  it('tar extracts each file at its whole path, with its mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'files-tar-'));
    try {
      writeFileSync(join(dir, 'in.tar'), filesTar([{ name: LONG, data: Buffer.from('{}'), mode: 0o644 }, { name: 'ops/step.sh', data: '#!/bin/sh\n', mode: 0o755 }]));
      execFileSync('tar', ['-xf', join(dir, 'in.tar'), '-C', dir]);
      expect(readFileSync(join(dir, LONG), 'utf8')).toBe('{}');
      expect(execFileSync('stat', ['-c', '%a', join(dir, 'ops/step.sh')]).toString().trim()).toBe('755');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
