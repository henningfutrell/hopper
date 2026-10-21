// What's new at a commit of the update mirror is read with a few git processes, however many fragments there are
// (issue #2367): the update check runs every minute, and each process the daemon starts holds its event loop.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitMirror, notesAt } from '../../src/update/git.ts';
import { createUpstream, tempDir } from './support.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function mirrored(fragments: number) {
  const root = tempDir('jh-notes-');
  dirs.push(root);
  const up = createUpstream(root);
  up.whatsNew(['the file line']);
  for (let i = 0; i < fragments; i++) up.fragment(`${i}.md`, [`line ${i}`, `more ${i}: with a colon`]);
  up.fragment('empty.md', []);
  const commit = up.commit('first');
  const runs: string[][] = [];
  const mirror = createGitMirror(join(root, 'repo.git'), { onGit: (args) => runs.push(args) });
  return { up, commit, mirror, runs };
}

describe('notesAt', () => {
  it('reads every fragment and the file with at most three git processes', async () => {
    const { up, commit, mirror, runs } = mirrored(40);
    await mirror.fetch(up.dir);
    runs.length = 0;
    const notes = await notesAt(mirror, commit);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(3);
    expect(notes.file).toContain('- the file line');
    expect(notes.fragments).toHaveLength(41);
    expect(notes.fragments.find((f) => f.name === '7.md')?.text).toBe('- line 7\n- more 7: with a colon\n');
    expect(notes.fragments.find((f) => f.name === 'empty.md')?.text).toBe('');
  });

  it('gives no notes for a commit the mirror does not have', async () => {
    const { up, mirror } = mirrored(2);
    await mirror.fetch(up.dir);
    expect(await notesAt(mirror, 'f'.repeat(40))).toEqual({ file: '', fragments: [] });
  });
});
