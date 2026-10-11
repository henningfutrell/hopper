// The Pull requests list (issue #637, design.md "PR waiting"): every hopper pull request that waits — a done job's,
// followed after its end (PR waiting) — one closed without a merge, which waits on a person, and one its item's tend job
// works on (issue #763: the tended job follows it no more, but it is still open), grouped per job repository with its yolo mode; and the header: how many repositories have yolo mode on, and where merging waits. A
// merged one drops off. Only the newest job of an item counts: a job run again since is not waiting. Pure: built from the
// jobs as their follow-ups last saw them (`PullRequestSeen`), never from GitHub at read time, and the time now (the
// no-checks grace window, issue #677).
import type { Job } from './types.ts';
import { noChecksSettled, readyToMerge, type PullRequestSeen, type Tended } from './pull-requests.ts';
import { yoloModeFor, type YoloModeSettings } from './yolo-mode.ts';

/**
 * Why a waiting pull request is not merged yet: the first that holds, in this order. `no pull request`: none named nor
 * found yet. `tending`: its item's tend job works on it; `tend failed`: that job failed, and it waits on a person (issue
 * #763). `checks not started`: it has no checks, inside the grace window after its last push. `ready`: yolo mode on and it
 * is ready, so the next sync merges it (issue #677).
 */
export const MERGE_WAITS = [
  'no pull request', 'tending', 'tend failed', 'not checked yet', 'draft', 'conflicts', 'checks failing', 'yolo off', 'checks pending', 'checks not started', 'merge refused', 'ready',
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
}

export interface PullRequestsView {
  /** How many repositories have yolo mode on, of how many. */
  yolo: { on: number; total: number };
  /** Where merging waits: per repository and reason, the most first. */
  waiting: { repo: string; count: number; reason: MergeWait }[];
  /** Every job repository, and any other a card is in, with its yolo mode and its cards, oldest first. */
  repos: { repo: string; yolo: boolean; pullRequests: PullRequestCard[] }[];
}

interface Followed { pullRequest?: string; follow?: string; part?: boolean; seen?: PullRequestSeen; tended?: Tended }

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
 * A finished job that waits on its pull request (PR waiting), or one closed without a merge: the newest of its item. Or one
 * whose pull request its item's tend job works on (issue #763).
 */
export function waitsOnPullRequest(job: Job, newest: (key: string) => Job | undefined): boolean {
  const f = followedOf(job).follow;
  if (job.status !== 'finished' || job.source?.repo === undefined || job.source.number === undefined) return false;
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
  if (seen.checks === 'none' && !noChecksSettled(seen, now)) return 'checks not started';
  if (seen.mergeError || !readyToMerge(seen, now)) return 'merge refused';
  return 'ready';
}

function cardOf(job: Job, yolo: boolean, now: number, tendJob: Job | undefined): PullRequestCard {
  const f = followedOf(job);
  const seen = f.seen;
  const state = f.follow === 'open' || tendJob ? 'open' : 'closed';
  const waits = tendJob ? (['failed', 'cancelled', 'rejected'].includes(tendJob.status) ? 'tend failed' : 'tending') : waitOf(f.pullRequest !== undefined, seen, yolo, now);
  return {
    jobId: job.id, repo: job.source!.repo!, issue: { number: job.source!.number!, url: job.source!.url ?? job.source!.key },
    ...(f.pullRequest ? { pullRequest: { number: numberOf(f.pullRequest), url: f.pullRequest } } : {}),
    part: f.part === true, state, checks: seen?.checks ?? 'unknown', mergeable: seen ? (seen.conflicting ? 'conflicts' : 'mergeable') : 'unknown',
    draft: seen?.draft ?? false, ...(seen?.base ? { base: seen.base } : {}), ...(seen?.openedAt ? { openedAt: seen.openedAt } : {}),
    ...(job.finishedAt ? { since: job.finishedAt } : {}), yolo,
    ...(state === 'open' ? { waits } : {}), ...(tendJob ? { tendJobId: tendJob.id } : {}), ...(seen?.mergeError ? { mergeError: seen.mergeError } : {}),
  };
}

/** The list: `jobs` the finished ones to look at, `newest` the newest job of an item, `repos` the job repositories, `now` in ms. */
export function pullRequestList(jobs: Job[], newest: (key: string) => Job | undefined, yolo: YoloModeSettings, repos: string[], now: number): PullRequestsView {
  const waiting = jobs.filter((j) => waitsOnPullRequest(j, newest));
  const names: string[] = [];
  for (const r of [...repos, ...waiting.map((j) => j.source!.repo!)]) if (!names.some((n) => n.toLowerCase() === r.toLowerCase())) names.push(r);
  const groups = names.map((repo) => {
    const on = yoloModeFor(yolo, repo);
    const cards = waiting.filter((j) => j.source!.repo!.toLowerCase() === repo.toLowerCase()).map((j) => cardOf(j, on, now, tendJobOf(j, newest)))
      .sort((a, b) => (a.openedAt ?? a.since ?? '').localeCompare(b.openedAt ?? b.since ?? '') || a.jobId.localeCompare(b.jobId));
    return { repo, yolo: on, pullRequests: cards };
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
