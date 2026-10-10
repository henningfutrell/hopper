// A job's pull request after done (issue #579, design.md "Done is a pull request"). Whether a job that ended done is
// done, partly done or not (`judge`): done — its source finds its work complete; partly done — not complete, but its
// own pull request ships part of its item ("Part of #N"); else not, with why — and, when the job's own pull request is
// left with merge conflicts or as a draft, the fixed step that finishes it (issue #626): the job goes on with its brief
// in place of a hand-off. And what a source tells the sync loop when it follows an ended job's pull request: merged, or
// closed without a merge. Pure but for the source it asks.
import type { Job } from './types.ts';

/** Why a done job is not done, from its source; undefined when it is. A throw: the source could not tell. */
type NotComplete = (job: Job) => Promise<string | undefined>;

export interface FollowsPullRequests {
  /**
   * The URL of the job's own pull request that ships part of its item, open and ready for review or merged; undefined:
   * none. Asked when a done job is not complete: a part ends the run partly done, not failed. Absent: no parts.
   */
  partlyDone?(job: Job): Promise<string | undefined>;
  /**
   * The job's own open pull request that one fixed step finishes (issue #626): with merge conflicts, rebase it; a draft
   * free of them, mark it ready for review. Asked when a done job is neither complete nor partly done; undefined: none.
   * Absent: the source names no such step.
   */
  unfinishedPullRequest?(job: Job): Promise<UnfinishedPullRequest | undefined>;
  /**
   * Follow an ended job's pull request, as its source state after its report names it: undefined while it waits; merged
   * or closed without a merge, with the source state to keep. A throw is asked again on a later sync. Absent: nothing followed.
   */
  follow?(job: Job): Promise<FollowUp | undefined>;
}

export interface FollowUp {
  outcome: 'merged' | 'closed';
  pullRequest: string;
  /** The pull request shipped part of the item: merged, the next part may be taken. */
  part: boolean;
  /** The job's source state from now on. */
  state: Record<string, unknown>;
}

/** The fixed step that finishes a job's own pull request (issue #626): `rebase` onto its base, or `mark_ready` for review. */
export const FINISH_STEPS = ['rebase', 'mark_ready'] as const;
export type FinishStep = (typeof FINISH_STEPS)[number];

/** The job's own pull request, by URL, and the step that finishes it. */
export interface UnfinishedPullRequest { pullRequest: string; step: FinishStep }

/** The most finish briefs one run of a job gets (issue #626): rebase, then mark ready. Then it fails, as before. */
export const MAX_FINISH_BRIEFS = 2;

/** What the job is told to finish its pull request (issue #626): fixed text, no model call. */
export function finishBrief(f: UnfinishedPullRequest): string {
  const lines = f.step === 'rebase'
    ? [`Your pull request ${f.pullRequest} has merge conflicts with its base branch. The job is not done yet.`,
      'Fetch the base branch.', 'Rebase your branch onto it.', 'Resolve every conflict and keep the intent of both sides.',
      'Run the repo\'s checks.', 'Push the branch with --force-with-lease.']
    : [`Your pull request ${f.pullRequest} is a draft. A draft is not done.`,
      'Make sure the repo\'s checks pass.', 'Mark the pull request ready for review (gh pr ready).'];
  return [...lines, 'Do not open a new pull request.', 'Then end the job as done.'].join('\n');
}

/**
 * Done, partly done (the part's pull request), or not, with why — and the step that finishes the job's own pull
 * request, when one fixed step does (issue #626).
 */
export type Verdict = { done: true } | { done: false; partlyDone: string } | { done: false; why: string; finish?: UnfinishedPullRequest };

type Judged = { notComplete?: NotComplete } & Pick<FollowsPullRequests, 'partlyDone' | 'unfinishedPullRequest'>;

/** The verdict on a done job, from its source: a source that judges nothing takes every done job as done. */
export async function judge(source: Judged | undefined, job: Job): Promise<Verdict> {
  const why = await source?.notComplete?.(job);
  if (why === undefined) return { done: true };
  const part = await source?.partlyDone?.(job);
  if (part !== undefined) return { done: false, partlyDone: part };
  const finish = await source?.unfinishedPullRequest?.(job);
  return finish === undefined ? { done: false, why } : { done: false, why, finish };
}

/**
 * Why the job's work is over at its source while the job still runs (issue #627), or undefined: its own pull request is
 * ready for review — the whole issue, or a part — or its issue is closed as complete; or its issue is closed by any
 * other means, or gone (`workState`, issue #621). A source that judges nothing tells nothing. A throw: the source could not tell.
 */
export async function overAtSource(source: { notComplete?: NotComplete; partlyDone?: FollowsPullRequests['partlyDone']; workState?(job: Job): Promise<{ item: string } | undefined> } | undefined, job: Job): Promise<string | undefined> {
  if (!source?.notComplete) return undefined;
  const v = await judge(source, job);
  if (v.done) return 'its pull request is ready for review, or its issue is closed as complete';
  if ('partlyDone' in v) return `its pull request ${v.partlyDone} is ready for review and ships part of its issue`;
  const item = (await source.workState?.(job))?.item;
  return item === undefined || item === 'open' ? undefined : `its issue is ${item === 'gone' ? 'gone' : 'closed'}`;
}

/** Whether a failed job's work is done at its source (issue #637), asked before any run again: false for a source that does not judge. */
export async function doneAtSource(source: { notComplete?: NotComplete } | undefined, job: Job): Promise<boolean> {
  return source?.notComplete ? (await source.notComplete(job)) === undefined : false;
}

/** A source state that names an ended job's pull request still to follow (issue #579). */
export const following = (job: Job): boolean => (job.sourceState?.source as { follow?: unknown } | undefined)?.follow === 'open';
