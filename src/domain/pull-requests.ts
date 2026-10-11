// A job's pull request after done (issue #579, design.md "Done is a pull request"). Whether a job that ended done is
// done, partly done or not (`judge`): done — its source finds its work complete; partly done — not complete, but its
// own pull request ships part of its item ("Part of #N"); else not, with why — and, when the job's own pull request is
// left with merge conflicts, failing checks or as a draft, the fixed step that finishes it (issues #626, #736): the job
// goes on with its brief in place of a hand-off. And what a source tells the sync loop when it follows an ended job's pull
// request: merged, or closed without a merge — and, while it waits, the step that tends it (issue #736). And rework
// (issue #724): a person sends a done job's open pull request back with notes, and the brief its new job is told. Pure
// but for the source it asks.
import type { ActingPerson } from './failures.ts';
import type { Job } from './types.ts';

/** A person's act on a followed pull request (issue #677): Merge now, or Close PR without a merge. */
export const PULL_REQUEST_ACTS = ['merge', 'close'] as const;
export type PullRequestAct = (typeof PULL_REQUEST_ACTS)[number];

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
   * `act` (issue #677): a person's Merge now or Close PR on its open pull request, on the same path — merged whatever
   * yolo mode and its checks say, or closed without a merge; GitHub's refusal throws, and nothing is kept of it.
   */
  follow?(job: Job, act?: PullRequestAct): Promise<FollowUp | undefined>;
  /** Whether the hopper merges a ready pull request of `repo` (yolo mode): its tending queue waits for that merge (issue #796). Absent: never. */
  mergesOnReady?(repo: string): boolean;
  /**
   * Reconcile with the source (issue #763): of `jobs` — done, each the newest of its item, following no pull request —
   * the ones whose item is open and has an open pull request, each with the newest such pull request. A throw is asked
   * again on a later sync. Absent: nothing is reconciled.
   */
  unfollowedPullRequests?(jobs: Job[]): Promise<FoundPullRequest[]>;
}

/** An open pull request of a done job's item that the job does not follow (issue #763); `part`: it ships part of the item. */
export interface FoundPullRequest { jobId: string; pullRequest: string; part: boolean }

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
  /**
   * Open: it still waits, and what was seen of it changed (`state.seen`). Merged, or closed without a merge. Checked: a
   * merge recorded before issue #721 closed the item after all; only the state changes (`state.mergeChecked`). Abandoned
   * (issue #428): the item was closed as not planned while the pull request waited; it is followed no more, never merged.
   */
  outcome: 'open' | 'merged' | 'closed' | 'checked' | 'abandoned';
  pullRequest: string;
  /** Merged by the hopper itself (issue #637): yolo mode on for its repository, and it was ready. */
  byHopper?: boolean;
  /** The pull request shipped part of the item: merged, the next part may be taken. */
  part: boolean;
  /** The job's source state from now on. */
  state: Record<string, unknown>;
}

/**
 * The fixed step that finishes a job's own pull request (issue #626): `rebase` onto its base, `fix_checks` that fail
 * (issue #736), or `mark_ready` for review.
 */
export const FINISH_STEPS = ['rebase', 'fix_checks', 'mark_ready'] as const;
export type FinishStep = (typeof FINISH_STEPS)[number];

/** The job's own pull request, by URL, and the step that finishes it. */
export interface UnfinishedPullRequest { pullRequest: string; step: FinishStep }

/** The most finish briefs one run of a job gets (issues #626, #736): rebase, fix the checks, mark ready. Then it fails, as before. */
export const MAX_FINISH_BRIEFS = 3;

const numberOf = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? '';
const repoOf = (url: string): string => /\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '';

/** The steps of a finish brief or a tend brief: fixed text, no model call. */
function stepLines(f: UnfinishedPullRequest): string[] {
  if (f.step === 'rebase') {
    return [`Your pull request ${f.pullRequest} has merge conflicts with its base branch. The job is not done yet.`,
      'Fetch the base branch.', 'Rebase your branch onto it.', 'Resolve every conflict and keep the intent of both sides.',
      'Run the repo\'s checks.', 'Push the branch with --force-with-lease.'];
  }
  if (f.step === 'fix_checks') {
    return [`The checks of your pull request ${f.pullRequest} fail. The job is not done yet.`,
      'Read the failing checks and their logs.', 'Fix the cause on the branch of the pull request.',
      'Run the repo\'s checks.', 'Push the branch.'];
  }
  return [`Your pull request ${f.pullRequest} is a draft. A draft is not done.`,
    'Make sure the repo\'s checks pass.', `Mark the pull request ready for review: sh "$HOPPER_GH" pr ready ${numberOf(f.pullRequest)} --repo ${repoOf(f.pullRequest)}.`];
}

/** What the job is told to finish its pull request (issue #626): fixed text, no model call. Through the hopper (issue #652). */
export function finishBrief(f: UnfinishedPullRequest): string {
  return [...stepLines(f), 'Do not open a new pull request.', 'Then end the job as done.'].join('\n');
}

/** The tend steps (issue #736): what makes a waiting pull request need its job again. A draft is a person's, never tended. */
export const TEND_STEPS = ['rebase', 'fix_checks'] as const satisfies readonly FinishStep[];
export type TendStep = (typeof TEND_STEPS)[number];

/**
 * The most `fix_checks` tends in a row of one pull request (issue #736): then it waits on a person, as it did before tending.
 * A rebase is never capped (issue #786): each is made needed by a new merge on the base, and a rebase that fails ends the
 * row by itself.
 */
export const MAX_TENDS = 3;

/** The step that tends a waiting pull request as last seen (issue #736): merge conflicts first, then failing checks. */
export const tendStep = (seen: PullRequestSeen | undefined): TendStep | undefined =>
  !seen || seen.draft ? undefined : seen.conflicting ? 'rebase' : seen.checks === 'failing' ? 'fix_checks' : undefined;

/**
 * What the item's new job is told after its prompt when the hopper tends its waiting pull request (issue #736): go on with
 * that pull request, the step, and to fail saying why when it cannot. Fixed text, no model call.
 */
export function tendBrief(pullRequest: string, step: TendStep): string {
  return [`The hopper runs this issue again to tend its open pull request ${pullRequest}.`,
    `Work on the branch of ${pullRequest}.`, ...stepLines({ pullRequest, step }), 'Do not open a new pull request.',
    'If you cannot resolve a conflict or fix a check, end the job as failed. Say which files or checks, and why.',
    'Then end the job as done.'].join('\n');
}

/** What a tend left on the job it tended (issue #736), in its source state (`tended`): it follows no more. When: `job.pull_request_tended`. */
export interface Tended { pullRequest: string; step: TendStep; nextJobId: string }

/**
 * Set on the job that reworks a pull request (issue #724): the pull request a person sent back, their notes, when, and who
 * and the way. The job is done only when it pushed to that pull request after it was created and marked it ready.
 */
export interface JobRework extends Partial<ActingPerson> {
  pullRequest: string;
  notes: string;
  at: string;
}

/** The most characters of rework notes (issue #724). */
export const MAX_REWORK_NOTES = 8_000;

/** What the job that reworks a pull request is told after its item's prompt (issue #724): fixed text and the notes. */
export function reworkBrief(pullRequest: string, notes: string): string {
  return [
    `Your pull request ${pullRequest} was sent back for rework. It is a draft now. It is not done.`,
    'The rework notes:', ...notes.trim().split('\n').map((l) => `> ${l}`), '',
    'Check out the branch of that pull request. Do not open a new pull request.',
    'Make the changes the notes ask for. Keep the intent of the issue.',
    'Run the repo\'s checks.', 'Push to the same branch.',
    `Mark the pull request ready for review: sh "$HOPPER_GH" pr ready ${numberOf(pullRequest)} --repo ${repoOf(pullRequest)}.`,
    'Then end the job as done.',
  ].join('\n');
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

/**
 * How many `fix_checks` tends in a row of pull request `url` brought it to job `job` (issues #736, #786): the jobs it runs
 * again (`rerunOf`), back to the first that did not tend `url` to fix its checks. A rebase tend ends the row.
 */
export function tendsInRow(job: Job, url: string, get: (id: string) => Job | undefined): number {
  let n = 0;
  for (let j = job.rerunOf ? get(job.rerunOf) : undefined; j; j = j.rerunOf ? get(j.rerunOf) : undefined) {
    const t = (j.sourceState?.source as { tended?: Tended } | undefined)?.tended;
    if (t?.pullRequest !== url || t.step !== 'fix_checks') break;
    n += 1;
  }
  return n;
}

/**
 * A tend job that failed (issue #786): the job it runs again handed its pull request to it (`tended`). It waits on a person
 * ("tend failed"); reconciling never follows its pull request again.
 */
export const failedTend = (job: Job, get: (id: string) => Job | undefined): boolean =>
  job.status === 'failed' && job.rerunOf !== undefined
  && (get(job.rerunOf)?.sourceState?.source as { tended?: Tended } | undefined)?.tended?.nextJobId === job.id;

/** An end after which a job's pull request is followed (issues #579, #786): finished, or failed. */
export const followsWhenEnded = (job: Job): boolean => job.status === 'finished' || job.status === 'failed';

/** A source state that names an ended job's pull request still to follow (issue #579). A reworked one is not (issue #724). */
export const following = (job: Job): boolean => (job.sourceState?.source as { follow?: unknown } | undefined)?.follow === 'open';

/**
 * An ended job that may follow its item's open pull request when reconciled with its source (issue #763): finished — or
 * failed (issue #786): a pull request is followed to its end, whatever its job's end —, and following none — it ended
 * before the hopper followed pull requests, or its follow ended. Not one that a tend handed on (`tended`) or a rework
 * (`reworked`), nor one whose merge is still to check again. The caller checks it is the newest job of its item, and no
 * failed tend (`failedTend`).
 */
export const reconcilable = (job: Job): boolean => {
  const f = (job.sourceState?.source as { follow?: unknown } | undefined)?.follow;
  return followsWhenEnded(job) && f !== 'open' && f !== 'tended' && f !== 'reworked' && !rechecksMerge(job);
};

/**
 * Whether a finished job's merge is checked once more (issue #721): recorded as the whole item — merged, no part — and not
 * checked yet. Before issue #721 a merged part on a branch named for the issue was recorded as the whole item.
 */
export const rechecksMerge = (job: Job): boolean => {
  const s = job.sourceState?.source as { follow?: unknown; part?: unknown; mergeChecked?: unknown } | undefined;
  return s?.follow === 'merged' && s.part !== true && s.mergeChecked !== true;
};
