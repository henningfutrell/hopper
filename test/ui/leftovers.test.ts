// The leftovers on a Machines card (issue #1116): the model, pure.
import { describe, expect, it } from 'vitest';
import { ageText, leftoverText, removalText } from '../../ui/src/model/leftovers.ts';

const DAY = 86400_000;

describe('leftoverText', () => {
  it('says what it is, its size, its age, and the worktrees that use a mirror', () => {
    expect(leftoverText({ path: '/w/.hopper-scratch/x', kind: 'scratch', ageMs: 5 * DAY, unpushed: true, bytes: 2.4e9 })).toBe('old job files · 2.4 GB · 5 days old');
    expect(leftoverText({ path: '/w/.hopper-scratch/repos/a/b.git', kind: 'mirror', ageMs: DAY, unpushed: false, users: 1, bytes: 340e6 })).toBe('repository mirror · 340 MB · 1 day old · used by 1 worktree');
    expect(leftoverText({ path: '/w/.hopper-scratch/repos/a/b.git', kind: 'mirror', ageMs: 3 * 3600_000, unpushed: false, users: 0 })).toBe('repository mirror · 3 hours old · used by 0 worktrees');
  });

  it('says an age under a day in hours', () => {
    expect(ageText(0)).toBe('under an hour old');
    expect(ageText(3600_000)).toBe('1 hour old');
    expect(ageText(23 * 3600_000)).toBe('23 hours old');
    expect(ageText(2 * DAY)).toBe('2 days old');
  });
});

describe('removalText', () => {
  it('says the removal cannot be undone, and what it loses', () => {
    expect(removalText({ path: '/w/.hopper-scratch/x', kind: 'scratch', ageMs: DAY, unpushed: true })).toBe('The folder is removed on the machine, whatever it holds. It holds work not pushed: that work is lost. This cannot be undone.');
    expect(removalText({ path: '/w/.hopper-scratch/repos/a/b.git', kind: 'mirror', ageMs: DAY, unpushed: false, users: 2 })).toBe('The folder is removed on the machine, whatever it holds. It holds no work that is not pushed. The worktrees that use it stop working. This cannot be undone.');
  });
});
