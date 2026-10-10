// A job's pull request after done (issue #579, design.md "Done is a pull request"). Whether a job that ended done is
// done, partly done or not (`judge`): done — its source finds its work complete; partly done — not complete, but its
// own pull request ships part of its item ("Part of #N"); else not, with why — and, when the job's own pull request is
// left with merge conflicts or as a draft, the fixed step that finishes it (issue #626): the job goes on with its brief
// in place of a hand-off. And what a source tells the sync loop when it follows an ended job's pull request: merged, or
// closed without a merge. Pure but for the source it asks.
import type { Job } from './types.ts';

/** A pull request's head commit checks (issue #637): all passed, some still running, or one failed. None: absent. */
export type ChecksState = 'passing' | 'pending' | 'failing';

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
   * Follow an ended job's pull request, as its source state after its report names it: undefined while it waits as it
   * did; open, with what was seen of it, when that changed (issue #637); merged — with yolo mode on, by the hopper once it
   * is ready — or closed without a merge, with the source state to keep. A throw is asked again on a later sync. Absent: nothing followed.
   */
  follow?(job: Job): Promise<FollowUp | undefined>;
}

/**
 * What following a waiting pull request last saw of it (issue #637), kept in the job's source state (`seen`): what the
 * Pull requests list shows. `checks` none: it has no checks. `mergeError`: the hopper's own merge (yolo mode) was refused.
 */
export interface PullRequestSeen {
  draft: boolean;
  conflicting: boolean;
  checks: ChecksState | 'none';
  /** When it was opened. */
  openedAt?: string;
  /** When it was last pushed to (issue #677): the later of when it was opened and its head commit. */
  pushedAt?: string;
  /** The branch it merges into (issue #677: "conflicts with dev"). */
  base?: string;
  mergeError?: string;
}

/**
 * How long a pull request with no checks waits for checks to start after its last push (issue #677): a check that starts
 * late is not missed. After it, no checks counts as ready.
 */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;

/** No checks, and none started within the grace window after its last push (issue #677). Absent `pushedAt`: long ago. */
export const noChecksSettled = (seen: PullRequestSeen, now: number): boolean =>
  seen.checks === 'none' && (seen.pushedAt === undefined || now - Date.parse(seen.pushedAt) >= NO_CHECKS_GRACE_MS);

/**
 * Ready for the hopper's merge (yolo mode): not a draft, no merge conflicts, and its checks passed — or it has none,
 * settled (issue #677; issue #652 had none wait for ever). A repository's required checks still hold it: GitHub refuses
 * that merge, and the refusal is kept (`mergeError`).
 */
export const readyToMerge = (seen: PullRequestSeen, now: number): boolean =>
  !seen.draft && !seen.conflicting && (seen.checks === 'passing' || noChecksSettled(seen, now));

export interface FollowUp {
  /** Open: it still waits, and what was seen of it changed (`state.seen`). Merged, or closed without a merge. */
  outcome: 'open' | 'merged' | 'closed';
  pullRequest: string;
  /** Merged by the hopper itself (issue #637): yolo mode on for its repository, and it was ready. */
  byHopper?: boolean;
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

const numberOf = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? '';
const repoOf = (url: string): string => /\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '';

/** What the job is told to finish its pull request (issue #626): fixed text, no model call. Through the hopper (issue #652). */
export function finishBrief(f: UnfinishedPullRequest): string {
  const lines = f.step === 'rebase'
    ? [`Your pull request ${f.pullRequest} has merge conflicts with its base branch. The job is not done yet.`,
      'Fetch the base branch.', 'Rebase your branch onto it.', 'Resolve every conflict and keep the intent of both sides.',
      'Run the repo\'s checks.', 'Push the branch with --force-with-lease.']
    : [`Your pull request ${f.pullRequest} is a draft. A draft is not done.`,
      'Make sure the repo\'s checks pass.', `Mark the pull request ready for review: sh "$HOPPER_GH" pr ready ${numberOf(f.pullRequest)} --repo ${repoOf(f.pullRequest)}.`];
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
