// The commit the install runs (issue #2775 part 10), against real git repositories: an update check records it once, with
// the merge commits it carries beyond the one recorded before, so a job's kept delivery track sees the install run its change.
//
// Feature: the install's commit
//   Scenario: the first check records the commit with its merge commits; a check again records nothing
//   Scenario: the install runs a later commit: only the merge commits beyond the one recorded before
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstall, git } from './support.ts';
import { updater, world } from './world.ts';

describe('the commit the install runs', () => {
  it('records the commit the install runs once, with the merge commits it carries beyond the one recorded before (issue #2775 part 10)', async () => {
    const w = world();
    w.up.commit('first');
    const merge = (n: number): string => {
      git(w.up.dir, 'checkout', '-q', '-b', `topic-${n}`);
      writeFileSync(join(w.up.dir, `topic-${n}.txt`), `topic ${n}`);
      git(w.up.dir, 'add', '-A');
      git(w.up.dir, 'commit', '-q', '-m', `topic ${n}`);
      git(w.up.dir, 'checkout', '-q', 'stable');
      w.up.commit(`main ${n}`);
      git(w.up.dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, `topic-${n}`);
      return git(w.up.dir, 'rev-parse', 'HEAD');
    };
    const m1 = merge(1);
    const { u } = updater(w, createInstall(w.root, w.up.dir, m1));
    await u.check();
    await u.check();
    const seen = () => w.store.events.since(0).filter((e) => e.type === 'install.seen').map((e) => e.data);
    expect(seen()).toEqual([{ commit: m1, branch: 'stable', mergeCommits: [m1] }]);
    // The install now runs a later commit: only the merge commits beyond the one recorded before.
    const m2 = merge(2);
    createInstall(w.root, w.up.dir, m2);
    await u.check();
    expect(seen()).toEqual([{ commit: m1, branch: 'stable', mergeCommits: [m1] }, { commit: m2, branch: 'stable', from: m1, mergeCommits: [m2] }]);
  });
});
