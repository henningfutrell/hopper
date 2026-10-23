// The mirror made the first time (issue #858 part 2, design.md "Git efficiency"): two callers in one process that make the
// same mirror at once — a sync pass and a push requirements read (issue #2555) — each get a mirror, and neither removes the
// other's half-made one.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mirrorPathOf, readyMirror, runGit } from '../../src/git-mirror/mirrors.ts';

describe('a mirror made the first time', () => {
  it('two makes of one mirror at once both end with the mirror there', async () => {
    const path = mirrorPathOf(mkdtempSync(join(tmpdir(), 'hopper-ready-mirror-')), 'octo/tools');
    const url = 'https://github.invalid/octo/tools.git';
    const made = await Promise.all(Array.from({ length: 4 }, () => readyMirror(runGit, path, url, { GIT_CONFIG_NOSYSTEM: '1' })));
    expect(made).toEqual([undefined, undefined, undefined, undefined]);
    expect(existsSync(join(path, 'HEAD'))).toBe(true);
    expect((await runGit(['--git-dir', path, 'remote', 'get-url', 'origin'], {})).stdout.trim()).toBe(url);
  });
});
