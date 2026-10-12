// The tending queue (issue #796, design.md "The tending queue"): each merge moves its base, so the waiting pull requests of
// one job repository that need tending are tended one at a time, never all at once. The head — a pull request a tend job
// works on, or one on its way to the hopper's merge — holds the queue; once it is merged, closed, or waits on a person,
// the next is tended against the new base: one rebase per merge, never a rebase of the whole backlog that each merge
// breaks again. The rules' order: the highest priority first, then the oldest pull request. Jev may pick the head
// (`merge-order`). Pure.
import { following, type PullRequestSeen, type Tended, type TendStep } from './pull-requests.ts';
import type { Job } from './types.ts';

/** A waiting pull request a tend is due for: its job, the pull request, and the step. */
export interface TendDue { jobId: string; pullRequest: string; step: TendStep }

/** What holds a repository's tending queue: a tend job works on the pull request, or the hopper is to merge it. */
export interface QueueHead { pullRequest: string; why: 'tending' | 'merging' }

interface Followed { pullRequest?: string; follow?: string; seen?: PullRequestSeen; tended?: Tended }

const followedOf = (job: Job | undefined): Followed => (job?.sourceState?.source ?? {}) as Followed;
const ENDED: readonly string[] = ['failed', 'cancelled', 'rejected'];

/** A job's repository, lowercased: the queue's key. */
export const repoOf = (job: Job): string | undefined => job.source?.repo?.toLowerCase();

/**
 * The tend job at work on a pull request: one a tend handed the pull request to (`tended`), not ended — or finished and not
 * yet following it again (its end is still to report). A failed one waits on a person and holds nothing.
 */
function tending(job: Job, get: (id: string) => Job | undefined): string | undefined {
  const t = followedOf(job.rerunOf ? get(job.rerunOf) : undefined).tended;
  if (t?.nextJobId !== job.id || ENDED.includes(job.status)) return undefined;
  return job.status !== 'finished' || followedOf(job).follow === undefined ? t.pullRequest : undefined;
}

/**
 * On its way to the hopper's merge: followed, yolo mode on for its repository (`merges`), whatever its job's origin (issue
 * #805), and — as last seen — no draft, no merge conflicts, no failing checks and no refused merge. Not seen yet counts: the next
 * follow sees it.
 */
function merging(job: Job, merges: (repo: string) => boolean): string | undefined {
  const f = followedOf(job);
  if (!following(job) || !f.pullRequest || !merges(job.source!.repo!)) return undefined;
  const s = f.seen;
  return !s || (!s.draft && !s.conflicting && s.checks !== 'failing' && s.mergeError === undefined) ? f.pullRequest : undefined;
}

/** What holds `repo`'s tending queue now, of `jobs`; undefined: it is free, and the next may be tended. */
export function queueHead(repo: string, jobs: readonly Job[], get: (id: string) => Job | undefined, merges: (repo: string) => boolean): QueueHead | undefined {
  for (const job of jobs.filter((j) => repoOf(j) === repo)) {
    const t = tending(job, get);
    if (t) return { pullRequest: t, why: 'tending' };
  }
  for (const job of jobs.filter((j) => repoOf(j) === repo)) {
    const m = merging(job, merges);
    if (m) return { pullRequest: m, why: 'merging' };
  }
  return undefined;
}

/** The rules' order of a repository's due tends: the highest priority first, then the oldest pull request, then the job. */
export function tendOrder(due: readonly TendDue[], get: (id: string) => Job | undefined): TendDue[] {
  const opened = (d: TendDue) => followedOf(get(d.jobId)).seen?.openedAt ?? '';
  return [...due].sort((a, b) => (get(b.jobId)?.priority ?? 0) - (get(a.jobId)?.priority ?? 0)
    || opened(a).localeCompare(opened(b)) || a.jobId.localeCompare(b.jobId));
}
