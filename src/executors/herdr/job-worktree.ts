// Each job its own git worktree (issue #379): jobs on one machine share its work tree, so two jobs in one
// work tree stepped on each other (branches, the index lock, uncommitted files, builds). When the work tree
// is the top of a git repository, the pane's shell makes the job a worktree of it, under the work tree, and
// the job runs there; when the job ends, the worktree goes once nothing in it is uncommitted or unpushed.
// The commands run in the pane's own shell, so on whichever machine the work tree is. design.md "Work tree".

import type { HerdrClient } from './client.ts';
import { shellQuote } from '../ssh.ts';
import { SCRATCH_DIR } from '../../job-rules/index.ts';

/** Where the job worktrees of a work tree live, git-ignored by their own `.gitignore`. */
export const JOB_WORKTREES_DIR = '.hopper-jobs';

/** What a job worktree command prints, followed by its outcome. */
export const JOB_WORKTREE_MARK = 'hopper-job-worktree-';

/** made: the job runs in it; none: the work tree is not a repository's top; unmade: git refused; removed / kept: at the end. */
export type JobWorktreeOutcome = 'made' | 'none' | 'unmade' | 'removed' | 'kept';

export const jobWorktreeOf = (workTree: string, jobId: string): string => `${workTree.replace(/\/+$/, '')}/${JOB_WORKTREES_DIR}/${jobId}`;

// Printed as two words, so the command's own echo never reads as its outcome.
const say = (outcome: JobWorktreeOutcome): string => `printf 'hopper-job-%s-%s\\n' worktree ${outcome}`;

/**
 * Make the job's worktree of the work tree and enter it, in the pane's shell. Only a work tree that is
 * the top of a git repository gets one: a directory inside a repository (a home kept in git) is not
 * the job's repository. After a fetch (never prompting), detached at the remote's default branch, else
 * the current branch's upstream, else HEAD; a worktree an earlier run of the job left is entered as it
 * is. The shell's TMPDIR and Claude's scratchpad move to the worktree's own scratch dir.
 */
export function makeJobWorktreeCommand(workTree: string, path: string): string {
  const [tree, job, jobs, scratch] = [workTree, path, `${workTree.replace(/\/+$/, '')}/${JOB_WORKTREES_DIR}`, `${path}/${SCRATCH_DIR}`].map(shellQuote);
  const base = `"$(git rev-parse --verify --quiet refs/remotes/origin/HEAD || git rev-parse --verify --quiet '@{upstream}' || git rev-parse --verify HEAD)"`;
  return `cd ${tree} && if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then`
    + ` GIT_TERMINAL_PROMPT=0 git fetch --quiet 2>/dev/null;`
    + ` mkdir -p ${jobs} && printf '*\\n' > ${jobs}/.gitignore && git worktree prune`
    + ` && { [ -e ${job}/.git ] || git worktree add --quiet --detach ${job} ${base}; }`
    + ` && cd ${job} && mkdir -p ${scratch} && printf '*\\n' > ${scratch}/.gitignore`
    + ` && export TMPDIR=${scratch} CLAUDE_CODE_TMPDIR=${scratch}`
    + ` && ${say('made')} || ${say('unmade')}; else ${say('none')}; fi`;
}

/**
 * Remove the job's worktree, from the work tree it was made from, when nothing in it is uncommitted (its ignored files
 * aside) and no commit in it is missing from the remotes; a branch the job made goes with it, its
 * commits being pushed. Anything else keeps it, for whoever looks next. Removed when already gone.
 */
export function removeJobWorktreeCommand(workTree: string, path: string): string {
  const [tree, job] = [workTree, path].map(shellQuote);
  return `cd ${tree} && if [ ! -e ${job} ]; then ${say('removed')};`
    + ` elif [ -z "$(git -C ${job} status --porcelain 2>&1)" ] && [ -z "$(git -C ${job} log --oneline HEAD --not --remotes -- 2>&1)" ]; then`
    + ` hopper_branch="$(git -C ${job} symbolic-ref --quiet --short HEAD)";`
    + ` git worktree remove --force ${job} && { [ -z "$hopper_branch" ] || git branch --quiet -D "$hopper_branch"; } && ${say('removed')} || ${say('kept')};`
    + ` else ${say('kept')}; fi`;
}

/** The outcome the last job worktree command printed on the screen, if any. */
export function jobWorktreeOutcome(screen: string): JobWorktreeOutcome | undefined {
  const lines = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(JOB_WORKTREE_MARK));
  const last = lines.at(-1)?.slice(JOB_WORKTREE_MARK.length);
  return last === 'made' || last === 'none' || last === 'unmade' || last === 'removed' || last === 'kept' ? last : undefined;
}

/** Polls for Claude to leave the pane before the removal is typed: typed into Claude it would be a prompt. */
const EXIT_POLLS = 10;
const EXIT_POLL_MS = 500;
/** Removal runs again when the shell dropped it; each run waits this long for its outcome. */
const REMOVE_RUNS = 3;
const REMOVE_WAIT_MS = 5000;

/** A job's pane at its end, with the worktree in it. */
export interface JobWorktreePane { paneId: string; agentName: string; cwd: string; from: string }

/**
 * Remove the job's worktree from its pane's shell once Claude has exited there (issue #379). Undefined
 * when Claude never left the pane or the shell never answered: the worktree stays, as when kept.
 */
export async function removeJobWorktreeInPane(herdr: HerdrClient, sleep: (ms: number) => Promise<void>, pane: JobWorktreePane): Promise<JobWorktreeOutcome | undefined> {
  for (let polls = 0; ; polls++) {
    const agent = await herdr.getAgent(pane.agentName);
    if (!agent || agent.paneId !== pane.paneId) break;
    if (polls >= EXIT_POLLS) return undefined;
    await sleep(EXIT_POLL_MS);
  }
  const command = removeJobWorktreeCommand(pane.from, pane.cwd);
  for (let run = 0; run < REMOVE_RUNS; run++) {
    await herdr.runInPane(pane.paneId, command);
    if (await herdr.waitOutput(pane.paneId, `${JOB_WORKTREE_MARK}removed`, REMOVE_WAIT_MS)) return 'removed';
    if (jobWorktreeOutcome(await herdr.read(pane.paneId, { source: 'recent-unwrapped', lines: 40 })) === 'kept') return 'kept';
  }
  return undefined;
}
