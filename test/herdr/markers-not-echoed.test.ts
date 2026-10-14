// Every marker the hopper waits for on a pane is printed by what it types, never part of it (issues #518, #527):
// herdr's wait-output matched the echo of the typed command itself, and the job failed before its command ran.
// Each command builds its marker when it runs (`printf 'hopper-%s-%s'`), so its echo can never satisfy the wait.
import { describe, expect, it } from 'vitest';
import { JOB_WORKTREE_MARK, JOB_WORKTREE_RUNNING, makeJobWorktreeCommand } from '../../src/executors/herdr/job-worktree.ts';
import { SCOPE_MARK, enterScopeCommand, scopeCheckCommand } from '../../src/executors/herdr/job-scope.ts';
import { DEPS_MARK, shareDepsCommand } from '../../src/executors/herdr/shared-deps.ts';
import { SCRATCH_READY, SCRATCH_UNUSABLE, scratchCommand } from '../../src/executors/herdr/start.ts';

const JOB = 'abcdef12-3456-7890-abcd-ef1234567890';
const TREE = '/home/dev/work';
const WORKTREE = `${TREE}/.hopper-scratch/${JOB}/hopper`;

const cases: [string, string, string[]][] = [
  ['the scratch dir command', scratchCommand(TREE, JOB, true), [SCRATCH_READY, SCRATCH_UNUSABLE]],
  ['the scope command', enterScopeCommand(JOB), [SCOPE_MARK]],
  ['the scope check', scopeCheckCommand(JOB), [SCOPE_MARK]],
  ['the job worktree command', makeJobWorktreeCommand(TREE, JOB), [JOB_WORKTREE_RUNNING, JOB_WORKTREE_MARK]],
  ['the job worktree command with a repository', makeJobWorktreeCommand(TREE, JOB, { repo: 'owner/hopper' }), [JOB_WORKTREE_RUNNING, JOB_WORKTREE_MARK]],
  ['the dependency-sharing command', shareDepsCommand(TREE, WORKTREE, 24), [DEPS_MARK]],
];

describe('the markers a pane is waited on for', () => {
  it.each(cases)('%s never holds its own marker, all whitespace aside', (_what, command, marks) => {
    const echo = command.replace(/\s+/g, '');
    for (const mark of marks) {
      expect(typeof mark === 'string' && mark.length > 0, String(mark)).toBe(true);
      expect(echo).not.toContain(mark);
    }
  });
});
