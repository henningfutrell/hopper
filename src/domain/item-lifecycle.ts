// The item lifecycle (issue #1891, design.md "The item lifecycle"): who owns a work item in each state of the work-item
// ledger, when it is checked next, its deadline, the one reference a state needs, and what the item
// reconciler corrects. The ledger's reducer (`work-items.ts`) folds the events; this module says what each
// state promises and when a state broke its promise. Pure: no I/O, no clock — `now` is passed in.
import type { EventType } from './types.ts';
import type { WorkItem, WorkItemState } from './work-items.ts';

/**
 * Who moves an item out of a state: `scheduler` (the engine's queue), `lane_worker` (the job at work in its lane),
 * `github_observer` (the follow of its pull request and the reads of its issue), `assessor` (the failure assessor),
 * `reconciler` (the item reconciler), `person` (an act in the UI).
 */
export const ITEM_OWNERS = ['scheduler', 'lane_worker', 'github_observer', 'assessor', 'reconciler', 'person'] as const;
export type ItemOwner = typeof ITEM_OWNERS[number];

/**
 * Why an item is blocked: past its deadline with no move (`stale`), no pull request to wait on (`no_pr`), or its pull request
 * closed without a merge on GitHub (`pr_closed`): the first time the item reconciler runs it again by itself, once.
 */
export const BLOCKED_CAUSES = ['stale', 'no_pr', 'pr_closed'] as const;
export type BlockedCause = typeof BLOCKED_CAUSES[number];

/** What a blocked item waits on, in plain words. */
export const BLOCKED_WORDS: Readonly<Record<BlockedCause, string>> = {
  stale: 'a person: it stayed past its deadline with no move',
  no_pr: 'a pull request: none was found for it',
  pr_closed: 'a person: its pull request was closed without a merge',
};

/** What each state promises: its owner, how often it is checked, and its deadline from `stateSince` (absent: none). */
interface StatePromise { owner: ItemOwner; checkMs: number; deadlineMs?: number }

const MINUTE = 60_000;

/**
 * The promise of each state not ended. Only `pr_open` has a deadline: an hour on with no open pull request a job follows,
 * it is stale (issue #1231, `prOpenStuck`). A state a job or a person holds has none: a job's lane, its own wait and a
 * person's answer have their own deadlines, and a request card waits as long as a person likes.
 */
const PROMISES: Readonly<Partial<Record<WorkItemState, StatePromise>>> = {
  waiting_for_approval: { owner: 'person', checkMs: 30 * MINUTE },
  queued: { owner: 'scheduler', checkMs: 5 * MINUTE },
  working: { owner: 'lane_worker', checkMs: 5 * MINUTE },
  needs_you: { owner: 'person', checkMs: 30 * MINUTE },
  waiting_outside: { owner: 'lane_worker', checkMs: 30 * MINUTE },
  pr_open: { owner: 'github_observer', checkMs: 5 * MINUTE, deadlineMs: 60 * MINUTE },
  partly_done: { owner: 'scheduler', checkMs: 30 * MINUTE },
  failed: { owner: 'assessor', checkMs: 30 * MINUTE },
  blocked: { owner: 'person', checkMs: 5 * MINUTE },
};

/** The states an item ends in: no owner, no check. */
export const ENDED_STATES: readonly WorkItemState[] = ['done', 'dropped'];

/** The owner, the next check and the deadline of an item in `state` since `since`; undefined for an ended state. */
export function checkOf(state: WorkItemState, since: string, at: string = since): { owner: ItemOwner; nextCheckAt: string; deadline?: string } | undefined {
  const p = PROMISES[state];
  if (!p) return undefined;
  const plus = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString();
  return { owner: p.owner, nextCheckAt: plus(at, p.checkMs), ...(p.deadlineMs !== undefined ? { deadline: plus(since, p.deadlineMs) } : {}) };
}

/** Who makes each kind of move of the ledger: the transition's owner. */
export function transitionOwner(type: EventType): ItemOwner {
  if (type === 'work_item.reconciled') return 'reconciler';
  if (type.startsWith('work_item.') || type.startsWith('job.pull_request_') || type.startsWith('landing_batch.')) return 'github_observer';
  if (type === 'source.request_opened' || type === 'source.request_withdrawn' || type === 'source.request_auto_approved' || type === 'job.queued' || type === 'job.requeued') return 'scheduler';
  if (type.startsWith('source.request_') || type === 'job.dismissed' || type === 'handoff.closed' || type === 'job.unparked') return 'person';
  if (type === 'handoff.opened') return 'assessor';
  return 'lane_worker';
}

/**
 * Whether `event` is a pull request closed without a merge on GitHub (issue #1891): `job.pull_request_closed` that is no
 * person's Close PR, not the hopper's close as superseded, and no stray's.
 */
export const closedOnGitHub = (event: { type: EventType; data: Record<string, unknown> }): boolean =>
  event.type === 'job.pull_request_closed' && event.data.person === undefined && event.data.superseded === undefined && event.data.byHopper !== true && event.data.stray !== true;

/** The states that need a pull request named: `pr_open` waits on one, so with none it cannot be written. */
export const NEEDS_PULL_REQUEST: readonly WorkItemState[] = ['pr_open'];

/** Whether `item` may stand in `state`: a state that waits on a pull request names one. */
export const hasReference = (state: WorkItemState, item: Pick<WorkItem, 'pullRequest'>): boolean =>
  !NEEDS_PULL_REQUEST.includes(state) || item.pullRequest !== undefined;

/** The job of an item as the reconciler reads it: its status, whether it ended, and the pull request its report kept. */
export interface ReconcileJob { id: string; status: string; ended: boolean; updatedAt?: string; pullRequest?: string }

/**
 * A corrective move of the item reconciler: `replay`, fold the item again from its job's end (the ledger missed it, or an
 * event after it moved the item back); `block`, the item broke its state's promise.
 */
export type ItemCorrection =
  | { kind: 'replay'; key: string; jobId: string; from: WorkItemState }
  | { kind: 'block'; key: string; from: WorkItemState; cause: BlockedCause }
  | { kind: 'run_again'; key: string; jobId: string; pullRequest?: string };

/**
 * Whether a blocked item is stuck work for a person (Failures' `pr_open_stale`): blocked as stale, or for want of a pull
 * request for `BLOCKED_NO_PR_MS` — a job's end is blocked on it until its report names the pull request, a moment later.
 */
export function blockedStuck(item: Pick<WorkItem, 'state' | 'stateSince' | 'blockedCause' | 'closedWithoutMerge'>, now: string): boolean {
  if (item.state !== 'blocked') return false;
  if (runsAgainBySelf(item, now)) return false;
  return item.blockedCause !== 'no_pr' || Date.parse(now) - Date.parse(item.stateSince) >= BLOCKED_NO_PR_MS;
}

/**
 * How long after its pull request's first close without a merge the item reconciler still runs the item again by itself:
 * a close older than that (one a rebuild of the ledger finds, from before the rule) waits on a person.
 */
export const RUN_AGAIN_WINDOW_MS = 24 * 60 * MINUTE;

/**
 * Whether the item reconciler runs the item again by itself (issue #1891): blocked because its pull request was closed
 * without a merge on GitHub, the first time in a row, within `RUN_AGAIN_WINDOW_MS` of that close. A second close in a
 * row waits on a person: Run again or Won't do.
 */
export const runsAgainBySelf = (item: Pick<WorkItem, 'state' | 'stateSince' | 'blockedCause' | 'closedWithoutMerge'>, now: string): boolean =>
  item.state === 'blocked' && item.blockedCause === 'pr_closed' && item.closedWithoutMerge === 1 && Date.parse(now) - Date.parse(item.stateSince) < RUN_AGAIN_WINDOW_MS;
/** How long an item blocked for want of a pull request waits before a person is asked: its report names one before. */
export const BLOCKED_NO_PR_MS = 10 * MINUTE;

/** How long a change stays too new for the reconciler: the events in flight settle first. */
export const RECONCILE_GRACE_MS = 2 * MINUTE;

/**
 * What the reconciler corrects of `item` at `now`, else undefined. `job`: the job the item names (undefined: none, or
 * none found); `follows`: a job follows the item's open pull request. An item queued or working whose job ended is folded
 * again from that job's end (the item names its newest job, so no live job comes after it), and so is an item blocked for
 * want of a pull request whose finished job's report has named one since; an item past its deadline in PR open with no
 * open pull request a job follows is blocked: `no_pr` with none named, else `stale`. An item blocked because its pull
 * request was closed without a merge for the first time in a row (`runsAgainBySelf`) runs again: its ended job's Run again.
 */
export function correctionOf(item: WorkItem, job: ReconcileJob | undefined, follows: boolean, now: string): ItemCorrection | undefined {
  const settledBefore = Date.parse(now) - RECONCILE_GRACE_MS;
  if (Date.parse(item.eventAt) > settledBefore) return undefined;
  if ((item.state === 'queued' || item.state === 'working') && job?.ended && job.id === item.jobId
    && (job.updatedAt === undefined || Date.parse(job.updatedAt) <= settledBefore)) {
    return { kind: 'replay', key: item.key, jobId: job.id, from: item.state };
  }
  if (runsAgainBySelf(item, now) && job?.ended && job.id === item.jobId) {
    return { kind: 'run_again', key: item.key, jobId: job.id, ...(item.pullRequest !== undefined ? { pullRequest: item.pullRequest } : {}) };
  }
  if (item.state === 'blocked' && item.blockedCause === 'no_pr' && job?.status === 'finished' && job.id === item.jobId && job.pullRequest !== undefined) {
    return { kind: 'replay', key: item.key, jobId: job.id, from: item.state };
  }
  if (item.state === 'pr_open') {
    const deadline = checkOf(item.state, item.stateSince)?.deadline;
    if (deadline === undefined || Date.parse(now) < Date.parse(deadline)) return undefined;
    if (item.pullRequest === undefined) return { kind: 'block', key: item.key, from: item.state, cause: 'no_pr' };
    if (item.pullRequestState !== 'open' || !follows) return { kind: 'block', key: item.key, from: item.state, cause: 'stale' };
  }
  return undefined;
}
