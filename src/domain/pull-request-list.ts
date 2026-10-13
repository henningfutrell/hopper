// The Pull requests list (issue #637, design.md "PR waiting"): every hopper pull request that waits — a done job's,
// followed after its end (PR waiting) — one closed without a merge, which waits on a person, and one its item's tend job
// works on (issue #763: the tended job follows it no more, but it is still open), grouped per job repository with its yolo mode; and the header: how many repositories have yolo mode on, and where merging waits. A
// merged one drops off. Only the newest job of an item counts: a job run again since is not waiting. Pure: built from the
// jobs as their follow-ups last saw them (`PullRequestSeen`), never from GitHub at read time, and the time now (the
// no-checks grace window, issue #677). A card that needs tending says what the hopper does about it (issue #927): tended
// next, held behind a head of its repository's tending queue that conflicts with it, or given up on, and why; a ready one
// whose merge is held says behind which (issue #939). What holds each is kept on its job by the sync (`Holds`, `seen`).
// A card a tend job works on says the step, and one whose tend job failed is given up on, in the words of that job's failure.
// A tend job not at work yet says why it waits (issue #967): no free lane, or its hold; a tend the source refused says why.
// A tend job cancelled by no person and no source is tended again (issue #1010): its card waits on the tend, and says when.
import type { Job } from './types.ts';
import { followsWhenEnded, MAX_TEND_RETRIES, MAX_TENDS, noChecksSettled, readyToMerge, tendRetryAt, tendsInRow, type PullRequestSeen, type Tended, type TendStep } from './pull-requests.ts';
import type { Holds, QueueHead } from './tending-queue.ts';
import { yoloModeFor, type YoloModeSettings } from './yolo-mode.ts';

// The list's repositories with no checks (issue #677) are their own module; re-exported here, as the list is in types.ts.
export * from './repo-checks.ts';

/**
 * Why a waiting pull request is not merged yet: the first that holds, in this order. `no pull request`: none named nor
 * found yet. `tending`: its item's tend job works on it; `tend failed`: that job failed, and it waits on a person (issue
 * #763). Its job's origin does not hold it (issue #805): the job already ran, so a pull request of a job with no origin
 * merges as any other. `checks unknown`: the hopper may not read its checks (issue #855). `checks not started`: it has no checks, inside the grace window after its last
 * push. `merge held`: ready, it conflicts with a pull request the hopper merged first (issue #939). `ready`: yolo mode
 * on and it is ready, so the next sync merges it (issue #677).
 */
export const MERGE_WAITS = [
  'no pull request', 'tending', 'tend failed', 'not checked yet', 'draft', 'conflicts', 'checks failing', 'yolo off', 'checks pending', 'checks unknown', 'checks not started', 'merge refused', 'merge held', 'ready',
] as const;
export type MergeWait = (typeof MERGE_WAITS)[number];

export interface PullRequestCard {
  jobId: string;
  repo: string;
  /** The issue it closes, or ships part of (`part`). */
  issue: { number: number; url: string };
  /** Absent: the job's report could name none; it is followed only to its merge. */
  pullRequest?: { number: number; url: string };
  part: boolean;
  /** `merged` never shows: a merged one drops off. */
  state: 'open' | 'merged' | 'closed';
  /** Its checks as last seen: `none`, it has none; `unknown`, not seen yet. */
  checks: PullRequestSeen['checks'] | 'unknown';
  mergeable: 'mergeable' | 'conflicts' | 'unknown';
  draft: boolean;
  /** The branch it merges into, as last seen (issue #677). */
  base?: string;
  /** When it was opened, as last seen. */
  openedAt?: string;
  /** When its job ended done. */
  since?: string;
  /** Its repository's yolo mode. */
  yolo: boolean;
  /** An open one: why it is not merged yet. */
  waits?: MergeWait;
  /** The hopper's own merge was refused: what GitHub said. */
  mergeError?: string;
  /** Its item's tend job, which works on it now or failed to (issue #763): no Merge now or Close PR meanwhile. */
  tendJobId?: string;
  /** The step that tend job takes (issue #927): rebase, or fix the checks. */
  tendStep?: TendStep;
  /**
   * One with merge conflicts or failing checks (issue #927): tended next, or held behind a pull request of its repository's
   * tending queue that conflicts with it (issue #939), and why. A ready one whose merge is held: behind the one merged first.
   * One whose tend the source refused (issue #967): why, so a refusal is never shown as "next".
   */
  queue?: { next: true } | { held: { pullRequest: number; why: QueueHead['why'] } } | { refused: string };
  /**
   * Its tend job is not at work yet (issue #967): why it waits — the lane cap that binds, or its hold; no reason kept, no
   * free lane yet. Absent: it works, or there is no tend job.
   */
  tendWaits?: string;
  /** The hopper tends it no more, and why (issue #927): it waits on a person. */
  gaveUp?: string;
}

export interface PullRequestsView {
  /** How many repositories have yolo mode on, of how many. */
  yolo: { on: number; total: number };
  /** Where merging waits: per repository and reason, the most first. */
  waiting: { repo: string; count: number; reason: MergeWait }[];
  /** Every job repository, and any other a card is in, with its yolo mode and its cards, oldest first. */
  repos: { repo: string; yolo: boolean; pullRequests: PullRequestCard[] }[];
}

interface Followed extends Holds { pullRequest?: string; follow?: string; part?: boolean; seen?: PullRequestSeen; tended?: Tended }

const followedOf = (job: Job): Followed => (job.sourceState?.source ?? {}) as Followed;
const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * The tend job that works on the job's pull request (issue #763): the job's follow went to it (`tended`), it is the newest
 * job of the item, and it has not finished — once finished, it follows the pull request itself, or there is none to follow.
 */
function tendJobOf(job: Job, newest: (key: string) => Job | undefined): Job | undefined {
  const t = followedOf(job).tended;
  const n = job.source ? newest(job.source.key) : undefined;
  return followedOf(job).follow === 'tended' && t && n?.id === t.nextJobId && n.status !== 'finished' ? n : undefined;
}

/**
 * A finished or failed job (issue #786) that waits on its pull request (PR waiting), or one closed without a merge: the newest of its item. Or one
 * whose pull request its item's tend job works on (issue #763).
 */
export function waitsOnPullRequest(job: Job, newest: (key: string) => Job | undefined): boolean {
  const f = followedOf(job).follow;
  if (!followsWhenEnded(job) || job.source?.repo === undefined || job.source.number === undefined) return false;
  return ((f === 'open' || f === 'closed') && newest(job.source.key)?.id === job.id) || tendJobOf(job, newest) !== undefined;
}

function waitOf(named: boolean, seen: PullRequestSeen | undefined, yolo: boolean, now: number): MergeWait {
  if (!named) return 'no pull request';
  if (!seen) return yolo ? 'not checked yet' : 'yolo off';
  if (seen.draft) return 'draft';
  if (seen.conflicting) return 'conflicts';
  if (seen.checks === 'failing') return 'checks failing';
  if (!yolo) return 'yolo off';
  if (seen.checks === 'pending') return 'checks pending';
  if (seen.checks === 'unknown') return 'checks unknown';
  if (seen.checks === 'none' && !noChecksSettled(seen, now)) return 'checks not started';
  if (seen.mergeError || !readyToMerge(seen, now)) return 'merge refused';
  return seen.mergeHeldBehind ? 'merge held' : 'ready';
}

/** A tend job's statuses before it is at work (issue #967): its card says why it waits. */
const NOT_AT_WORK: readonly string[] = ['queued', 'held'];

function cardOf(job: Job, yolo: boolean, now: number, tendJob: Job | undefined): PullRequestCard {
  const f = followedOf(job);
  const seen = f.seen;
  const state = f.follow === 'open' || tendJob ? 'open' : 'closed';
  const retryAt = tendRetryAt(f.tended, tendJob);
  const tendEnded = tendJob !== undefined && ['failed', 'cancelled', 'rejected'].includes(tendJob.status) && retryAt === undefined;
  const waits = tendJob ? (tendEnded ? 'tend failed' : 'tending') : waitOf(f.pullRequest !== undefined, seen, yolo, now);
  return {
    jobId: job.id, repo: job.source!.repo!, issue: { number: job.source!.number!, url: job.source!.url ?? job.source!.key },
    ...(f.pullRequest ? { pullRequest: { number: numberOf(f.pullRequest), url: f.pullRequest } } : {}),
    part: f.part === true, state, checks: seen?.checks ?? 'unknown', mergeable: seen ? (seen.conflicting ? 'conflicts' : 'mergeable') : 'unknown',
    draft: seen?.draft ?? false, ...(seen?.base ? { base: seen.base } : {}), ...(seen?.openedAt ? { openedAt: seen.openedAt } : {}),
    ...(job.finishedAt ? { since: job.finishedAt } : {}), yolo,
    ...(state === 'open' ? { waits } : {}), ...(tendJob ? { tendJobId: tendJob.id } : {}), ...(tendJob && f.tended ? { tendStep: f.tended.step } : {}),
    ...(tendJob && NOT_AT_WORK.includes(tendJob.status) ? { tendWaits: tendJob.waitReason ?? tendJob.holdReason ?? 'no free lane yet' } : {}),
    ...(retryAt !== undefined ? { tendWaits: `its tend job was cancelled: tended again from ${new Date(retryAt).toISOString()}` } : {}),
    ...(seen?.mergeError ? { mergeError: seen.mergeError } : {}),
  };
}

/** The most characters of a failed tend job's reason a card says (issue #927). */
const MAX_TEND_FAILURE = 300;

/**
 * Why a tend job ended without its step done (issue #927), from its failure: for a design-level conflict, the rebase brief
 * has it state the choice a person must make. Its reason on one line, cut to `MAX_TEND_FAILURE`.
 */
function tendFailure(tendJob: Job, step: TendStep | undefined, tended: Tended | undefined): string {
  const did = step === 'fix_checks' ? 'fixed its checks' : 'rebased it';
  const why = (tendJob.error ?? '').replace(/\s+/g, ' ').trim();
  if (tendJob.status === 'cancelled' && (tended?.retries ?? 0) >= MAX_TEND_RETRIES) {
    return `the job that ${did} was cancelled ${MAX_TEND_RETRIES + 1} times in a row: a person must look at it`;
  }
  if (why === '') return `the job that ${did} ended ${tendJob.status}: a person must look at it`;
  return `the job that ${did} failed: ${why.length > MAX_TEND_FAILURE ? `${why.slice(0, MAX_TEND_FAILURE - 1)}…` : why}`;
}

/**
 * Why the hopper tends the job's pull request no more (issue #927): its tend job failed, or its checks were fixed `MAX_TENDS`
 * times in a row.
 */
function gaveUpOn(job: Job, card: PullRequestCard, tendJob: Job | undefined, get: (id: string) => Job | undefined): string | undefined {
  if (card.waits === 'tend failed' && tendJob) return tendFailure(tendJob, card.tendStep, followedOf(job).tended);
  if (card.waits !== 'checks failing' || !card.pullRequest || tendsInRow(job, card.pullRequest.url, get) < MAX_TENDS) return undefined;
  return `checks still fail after ${MAX_TENDS} fixes: a person must look at them`;
}

/**
 * What the hopper does about each card that needs tending (issue #927): gave up, or its place in its repository's tending
 * queue — next, or held behind a pull request that conflicts with it (issue #939), as the sync kept it. A ready card whose
 * merge is held: behind the pull request merged first.
 */
function withQueue(cards: PullRequestCard[], waiting: Job[], tendJobs: Job[], get: (id: string) => Job | undefined): PullRequestCard[] {
  const heldAs = (pullRequest: string, why: QueueHead['why']) => ({ queue: { held: { pullRequest: numberOf(pullRequest), why } } });
  return cards.map((c) => {
    const job = waiting.find((j) => j.id === c.jobId)!;
    const f = followedOf(job);
    if (c.waits === 'merge held' && f.seen?.mergeHeldBehind) return { ...c, ...heldAs(f.seen.mergeHeldBehind, 'merging') };
    if (c.state !== 'open' || (c.waits !== 'conflicts' && c.waits !== 'checks failing' && c.waits !== 'tend failed')) return c;
    const gaveUp = gaveUpOn(job, c, tendJobs.find((t) => t.id === c.tendJobId), get);
    if (gaveUp) return { ...c, gaveUp };
    if (f.heldBehind) return { ...c, ...heldAs(f.heldBehind.pullRequest, f.heldBehind.why) };
    return { ...c, queue: f.tendRefused ? { refused: f.tendRefused } : { next: true } };
  });
}

/**
 * The list: `jobs` the finished ones to look at, `newest` the newest job of an item, `repos` the job repositories, `now` in
 * ms, `get` a job by id (a tend's chain, issue #927).
 */
export function pullRequestList(jobs: Job[], newest: (key: string) => Job | undefined, yolo: YoloModeSettings, repos: string[], now: number, get: (id: string) => Job | undefined): PullRequestsView {
  const waiting = jobs.filter((j) => waitsOnPullRequest(j, newest));
  const names: string[] = [];
  for (const r of [...repos, ...waiting.map((j) => j.source!.repo!)]) if (!names.some((n) => n.toLowerCase() === r.toLowerCase())) names.push(r);
  const groups = names.map((repo) => {
    const on = yoloModeFor(yolo, repo);
    const here = waiting.filter((j) => j.source!.repo!.toLowerCase() === repo.toLowerCase());
    const tendJobs = here.flatMap((j) => tendJobOf(j, newest) ?? []);
    const cards = here.map((j) => cardOf(j, on, now, tendJobOf(j, newest)))
      .sort((a, b) => (a.openedAt ?? a.since ?? '').localeCompare(b.openedAt ?? b.since ?? '') || a.jobId.localeCompare(b.jobId));
    return { repo, yolo: on, pullRequests: withQueue(cards, here, tendJobs, get) };
  });
  const counts = new Map<string, { repo: string; count: number; reason: MergeWait }>();
  for (const c of groups.flatMap((g) => g.pullRequests)) {
    if (!c.waits) continue;
    const k = `${c.repo}\n${c.waits}`;
    const at = counts.get(k) ?? counts.set(k, { repo: c.repo, count: 0, reason: c.waits }).get(k)!;
    at.count++;
  }
  return {
    yolo: { on: groups.filter((g) => g.yolo).length, total: groups.length },
    waiting: [...counts.values()].sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo) || a.reason.localeCompare(b.reason)),
    repos: groups,
  };
}
