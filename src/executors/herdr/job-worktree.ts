// Each job its own git worktree (issue #379): jobs on one machine share its work tree, so two jobs in one
// repository stepped on each other (branches, the index lock, uncommitted files, builds). When the work
// tree is the top of a git repository, the pane's shell makes the job a worktree of it inside the job's
// scratch dir, and Claude starts there. The reap removes it with the scratch dir when the job ends, or
// keeps it when it holds uncommitted or unpushed work (reap.ts). The command runs in the pane's own
// shell, so on whichever machine the work tree is. design.md "Work tree" → "Each job its own git worktree".

import { posix } from 'node:path';
import { SCRATCH_DIR } from '../../job-rules/index.ts';
import { shellQuote } from '../ssh.ts';

/** What the job worktree command prints, followed by its outcome. */
export const JOB_WORKTREE_MARK = 'hopper-job-worktree-';

/** made: the job runs in it; none: the work tree is not a repository's top; unmade: git refused. */
export type JobWorktreeOutcome = 'made' | 'none' | 'unmade';

/** The job's worktree: in its scratch dir, named as the work tree is. */
export function jobWorktreeOf(workTree: string, jobId: string): string {
  const tree = workTree.replace(/(.)\/+$/, '$1');
  return `${tree}/${SCRATCH_DIR}/${jobId}/${posix.basename(tree)}`;
}

// Printed as two words, so the command's own echo never reads as its outcome.
const say = (outcome: JobWorktreeOutcome): string => `printf 'hopper-job-%s-%s\\n' worktree ${outcome}`;

/**
 * Make the job's worktree of the work tree and enter it, in the pane's shell. Only a work tree that is
 * the top of a git repository gets one: a directory inside a repository (a home kept in git) is not
 * the job's repository. After a fetch (never prompting), detached at the remote's default branch, else
 * the current branch's upstream, else HEAD; a worktree an earlier run of the job left is entered as it is.
 */
export function makeJobWorktreeCommand(workTree: string, path: string): string {
  const [tree, job] = [workTree, path].map(shellQuote);
  const base = `"$(git rev-parse --verify --quiet refs/remotes/origin/HEAD || git rev-parse --verify --quiet '@{upstream}' || git rev-parse --verify HEAD)"`;
  return `cd ${tree} && if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then`
    + ' GIT_TERMINAL_PROMPT=0 git fetch --quiet 2>/dev/null; git worktree prune'
    + ` && { [ -e ${job}/.git ] || git worktree add --quiet --detach ${job} ${base}; }`
    + ` && cd ${job} && ${say('made')} || ${say('unmade')}; else ${say('none')}; fi`;
}

/** The outcome the job worktree command printed on the screen, if it has. */
export function jobWorktreeOutcome(screen: string): JobWorktreeOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(JOB_WORKTREE_MARK)).at(-1)?.slice(JOB_WORKTREE_MARK.length);
  return last === 'made' || last === 'none' || last === 'unmade' ? last : undefined;
}
