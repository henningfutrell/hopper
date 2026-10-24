// The tending queue (issue #796, design.md "The tending queue"): each merge moves its base, so the waiting pull requests of
// one job repository that need tending are not all tended at once. A head — a pull request a tend job works on, or one on
// its way to the hopper's merge — holds the pull requests that conflict with it; once it is merged, closed, or waits on a
// person, they are tended against the new base: one rebase per merge, never a rebase of the whole backlog that each merge
// breaks again. The rules' order: the highest priority first, then the oldest pull request. Jev may pick the first
// (`merge-order`). Pure.
// Nothing holds it for good (issue #927): a pull request on its way to the merge holds it only while it is seen ready, or
// its checks run within `PENDING_HOLD_MS` of its last push. Not seen yet, checks the hopper cannot read, or checks that
// stay pending hold nothing: the pull requests behind it are tended.
// One queue per set of pull requests that conflict, not per repository (issue #939): the source says whether two conflict
// (`JobSource.conflictBetween`, the hopper's mirror); the after-done half asks it, so pull requests whose changes do not
// conflict are tended at the same time. Where the source cannot say, they conflict: one tend at a time, as before.
// No hold lasts for ever (issue #1143): a due rebase held `MAX_HELD_MS` is tended whatever holds it.
// A merged pull request holds nothing (issue #1162): a tend job holds its queue only while it is at work or its end is still
// to report. A finished one whose end is reported holds nothing (it follows its pull request then, or the pull request was
// merged or closed first and there is nothing to follow), nor one that waits on a person, nor one whose pull request any
// job saw merged or closed.
// A tend job on its own command holds nothing (issue #1210): a job that waits on its own background command works on nothing
// meanwhile, as a job that waits on a person. One that ran a `sleep` loop to read another pull request held four pull requests
// for the whole hour of `MAX_HELD_MS`. Once its wait ends and it pushes, it is a head again.
import { following, jobPullRequestRepo, pullRequestRepo, tendOf, type PullRequestSeen, type Tended, type TendStep } from './pull-requests.ts';
import type { Job } from './types.ts';
import type { ChangeKind } from './change-kinds.ts';
import { ownWaitOf } from './own-command.ts';

/** A waiting pull request a tend is due for: its job, the pull request, and the step. */
export interface TendDue { jobId: string; pullRequest: string; step: TendStep }

/**
 * What holds a repository's tending queue: a tend job works on the pull request, or the hopper is to merge it. `jobId`: that
 * tend job, when a tend job holds it (issue #1162), so the card says the holder's state.
 */
export interface QueueHead { pullRequest: string; why: 'tending' | 'merging'; jobId?: string }

/**
 * What a waiting pull request that needs tending waits behind (issue #939), kept in its job's source state by the sync: a
 * head of its tending queue that conflicts with it, so it is not tended yet. Absent: nothing holds it.
 */
export interface Holds {
  heldBehind?: QueueHead;
  /** Why the source refused the last tend it was due (issue #967), kept until a tend starts: the card says it, never "next". */
  tendRefused?: string;
  /** Since when a head holds it (issue #1143), kept while it is held: held `MAX_HELD_MS`, it is tended anyway. */
  heldSince?: string;
}

/** How long a pull request whose checks run holds its repository's tending queue after its last push (issue #927). */
export const PENDING_HOLD_MS = 30 * 60_000;

/**
 * How long a head holds a due rebase at most (issue #1143): one hour. Pull requests that touch the same files all conflict,
 * and new ones on their way to the merge come all the time, so a held one could wait for ever with no job on it. After
 * this, it is tended whatever holds it: at worst it needs one more rebase after the next merge.
 */
export const MAX_HELD_MS = 60 * 60_000;

/** Whether a due tend held since `heldSince` (ISO) is held no more at `now` (ms): held `MAX_HELD_MS` or longer (issue #1143). */
export const heldTooLong = (heldSince: string | undefined, now: number): boolean =>
  heldSince !== undefined && now - Date.parse(heldSince) >= MAX_HELD_MS;

interface Followed { pullRequest?: string; follow?: string; seen?: PullRequestSeen; tended?: Tended }

const followedOf = (job: Job | undefined): Followed => (job?.sourceState?.source ?? {}) as Followed;
const ENDED: readonly string[] = ['failed', 'cancelled', 'rejected'];
/** A tend job's statuses that wait on a person (issue #1162): it works on nothing meanwhile, so it holds nothing. */
const WAITS_ON_PERSON: readonly string[] = ['waiting_answer', 'parked', 'operator_led'];
/** A followed pull request's ends (issue #1162): one seen so holds nothing. */
const FOLLOW_ENDS: readonly string[] = ['merged', 'closed', 'abandoned'];

/** The repository of a job's pull request (issue #1778: it may be another than its issue's), lowercased: the queue's key. */
export const repoOf = (job: Job): string | undefined => jobPullRequestRepo(job)?.toLowerCase();

/** The queue of a due tend of `job`: its pull request's repository, lowercased — a companion's may be another than the followed one's (issue #2752). */
export const dueRepoOf = (job: Job, pullRequest: string): string | undefined => { const r = repoOf(job); return r === undefined ? undefined : pullRequestRepo(pullRequest, r).toLowerCase(); };

/**
 * The tend job at work on a pull request: one a tend handed the pull request to (`tended`), not ended and not waiting on a
 * person — or finished, its end still to report (`reported`), and not following it again yet (issue #1162: once reported, it
 * follows the pull request, or there is none left to follow). A failed one waits on a person and holds nothing, and one on
 * its own command works on nothing and holds nothing (issue #1210).
 */
function tending(job: Job, get: (id: string) => Job | undefined, reported: (job: Job) => boolean): string | undefined {
  const t = tendOf(job, get);
  if (!t || ENDED.includes(job.status) || WAITS_ON_PERSON.includes(job.status) || ownWaitOf(job)) return undefined;
  if (job.status !== 'finished') return t.pullRequest;
  return followedOf(job).follow === undefined && !reported(job) ? t.pullRequest : undefined;
}

/**
 * Seen on its way to the merge now (issue #927): no draft, no merge conflicts, no refused merge, and its checks passed, or
 * it has none (the grace window, then the merge), or they run within `PENDING_HOLD_MS` of its last push.
 */
function soonMerged(s: PullRequestSeen, now: number): boolean {
  if (s.draft || s.conflicting || s.mergeError !== undefined) return false;
  if (s.checks === 'passing' || s.checks === 'none') return true;
  return s.checks === 'pending' && s.pushedAt !== undefined && now - Date.parse(s.pushedAt) < PENDING_HOLD_MS;
}

/**
 * On its way to the hopper's merge: followed, yolo mode on for its repository or its change kind's gate (`merges`), whatever its job's origin (issue
 * #805), and seen soon merged (issue #927).
 */
function merging(job: Job, merges: (repo: string, kind?: ChangeKind) => boolean, now: number): string | undefined {
  const f = followedOf(job);
  if (!following(job) || !f.pullRequest || !merges(jobPullRequestRepo(job)!, f.seen?.change?.kind)) return undefined;
  return f.seen && soonMerged(f.seen, now) ? f.pullRequest : undefined;
}

/**
 * The heads of `repo`'s tending queue at `now` (ms), of `jobs`: every tend job at work, then every pull request on its way to
 * the merge. `reported`: whether a job's end is reported to its source. A pull request any job saw merged or closed is no
 * head (issue #1162).
 */
export function queueHeads(repo: string, jobs: readonly Job[], get: (id: string) => Job | undefined, merges: (repo: string, kind?: ChangeKind) => boolean, now: number, reported: (job: Job) => boolean): QueueHead[] {
  const here = jobs.filter((j) => repoOf(j) === repo);
  const ended = new Set(here.flatMap((j) => { const f = followedOf(j); return f.pullRequest && FOLLOW_ENDS.includes(f.follow ?? '') ? [f.pullRequest] : []; }));
  return [
    ...here.flatMap((job): QueueHead[] => {
      const t = tending(job, get, reported);
      return t && !ended.has(t) ? [{ pullRequest: t, why: 'tending', jobId: job.id }] : [];
    }),
    ...here.flatMap((job): QueueHead[] => { const m = merging(job, merges, now); return m ? [{ pullRequest: m, why: 'merging' }] : []; }),
  ];
}

/** The rules' order of a repository's due tends, or ready merges: the highest priority first, then the oldest pull request, then the job. */
export function tendOrder<D extends { jobId: string }>(due: readonly D[], get: (id: string) => Job | undefined): D[] {
  const opened = (d: { jobId: string }) => followedOf(get(d.jobId)).seen?.openedAt ?? '';
  return [...due].sort((a, b) => (get(b.jobId)?.priority ?? 0) - (get(a.jobId)?.priority ?? 0)
    || opened(a).localeCompare(opened(b)) || a.jobId.localeCompare(b.jobId));
}
