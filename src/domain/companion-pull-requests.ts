// Companion pull requests (issue #1143 reopened, design.md "Companion pull requests"): an open pull request a job of an
// item opened through the hopper (`pr.create`), in the item's own repository, that is not the one the item's newest job
// follows. A job that changes two repositories opens one in each, and the hopper follows only one: before, the other got
// merge conflicts with its base and nothing tended it, as no job followed it, and the census skipped it, as the ledger holds
// it. Now each round of every follow reads it, and one with merge conflicts is rebased as a followed one is: the base
// merge first, else a rebase tend job of the item. Pure: the source reads each one.
import { pullRequestRepo, failedTend, followsWhenEnded, tendStep, type PullRequestSeen } from './pull-requests.ts';
import { handedToFollowOns } from './proposal-paths.ts';
import type { Job } from './types.ts';

/** What the last read of a companion pull request saw, kept on the item's newest job (`companions`, by URL). */
export interface CompanionSeen { conflicting: boolean; base?: string; headRef?: string; ended?: true }

/** A read of a companion pull request: its state, merge conflicts, base and head branch. */
export interface CompanionRead { url: string; state: 'open' | 'merged' | 'closed'; conflicting: boolean; base?: string; headRef?: string }

export interface ReadsCompanions {
  /**
   * Read each of `pulls` (issue #1143 reopened): its state, its merge conflicts with its base, and its branches. One the
   * source cannot read now is left out, and asked again at the next round. Absent: no companion is read.
   */
  readCompanions?(pulls: { repo: string; number: number }[]): Promise<CompanionRead[]>;
}

/** A companion pull request a rebase is due for: its URL, base and head branch. */
export interface CompanionDue { url: string; base?: string; headRef?: string }

type Source = { pullRequest?: string; follow?: string; companions?: Record<string, CompanionSeen> };
const sourceOf = (j: Job): Source | undefined => j.sourceState?.source as Source | undefined;
const order = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The newest job of an item may hold its companions: it ended (finished or failed), no tend job and no rework took its
 * pull request, no proposal handed its work on, and it is no failed tend (that one waits on a person, issue #786).
 */
export function holdsCompanions(job: Job, get: (id: string) => Job | undefined): boolean {
  const f = sourceOf(job)?.follow;
  return followsWhenEnded(job) && f !== 'tended' && f !== 'reworked' && !handedToFollowOns(job) && !failedTend(job, get);
}

/**
 * The companion pull requests of each item of `jobs` whose newest job holds them (`holdsCompanions`) and that `open` says
 * is not over: of the pull requests its jobs opened through the hopper (`opened`, asked only for those items), the ones of
 * its own repository, but the one that job follows and the ones a read saw end.
 */
export function companionsOf(jobs: readonly Job[], opened: (jobId: string) => readonly string[], get: (id: string) => Job | undefined, open: (key: string) => boolean): { holder: Job; companions: string[] }[] {
  const items = new Map<string, Job[]>();
  for (const j of jobs) if (j.source?.key && j.source.repo && j.source.number !== undefined) items.set(j.source.key, [...(items.get(j.source.key) ?? []), j]);
  const out: { holder: Job; companions: string[] }[] = [];
  for (const [key, js] of items) {
    const holder = [...js].sort(order).at(-1)!;
    if (!holdsCompanions(holder, get) || !open(key)) continue;
    const s = sourceOf(holder);
    const followed = s?.follow === 'open' ? s.pullRequest?.toLowerCase() : undefined;
    const repo = holder.source!.repo!.toLowerCase();
    const urls = new Set(js.flatMap((j) => opened(j.id)).filter((u) => pullRequestRepo(u, '').toLowerCase() === repo && u.toLowerCase() !== followed && !s?.companions?.[u]?.ended));
    if (urls.size > 0) out.push({ holder, companions: [...urls].sort() });
  }
  return out;
}

/** The companions kept on `job` after `read`: what each read saw, the companions not read kept as they were. */
export function companionsAfter(job: Job, companions: readonly string[], read: readonly CompanionRead[]): Record<string, CompanionSeen> {
  const before = sourceOf(job)?.companions ?? {};
  const after: Record<string, CompanionSeen> = { ...before };
  for (const url of companions) {
    const r = read.find((x) => x.url.toLowerCase() === url.toLowerCase());
    if (!r) continue;
    after[url] = r.state === 'open'
      ? { conflicting: r.conflicting, ...(r.base ? { base: r.base } : {}), ...(r.headRef ? { headRef: r.headRef } : {}) }
      : { conflicting: false, ended: true };
  }
  return after;
}

/**
 * The companion pull request of `job` a rebase is due for: the first one the last read saw open with merge conflicts.
 * Only while `job` holds companions, and its followed pull request needs no tend itself (that one goes first).
 */
export function companionDue(job: Job, get: (id: string) => Job | undefined): CompanionDue | undefined {
  const s = sourceOf(job);
  if (!s?.companions || !holdsCompanions(job, get)) return undefined;
  if (s.follow === 'open' && s.pullRequest && tendStep((s as { seen?: PullRequestSeen }).seen)) return undefined;
  const [url, seen] = Object.entries(s.companions).sort(([a], [b]) => a.localeCompare(b)).find(([u, c]) => c.conflicting && !c.ended && u.toLowerCase() !== s.pullRequest?.toLowerCase()) ?? [];
  return url && seen ? { url, ...(seen.base ? { base: seen.base } : {}), ...(seen.headRef ? { headRef: seen.headRef } : {}) } : undefined;
}

/**
 * `job` as if it followed its companion `url` (its base and head branch as last read): what the base merge, the tending
 * queue's conflict check and the base tip read of a companion's rebase are asked with. Not a companion of `job`: `job`.
 */
export function asFollowing(job: Job, url: string): Job {
  const s = sourceOf(job);
  const c = s?.companions?.[url];
  if (!c || url === s?.pullRequest) return job;
  const seen = { ...(c.base ? { base: c.base } : {}), ...(c.headRef ? { headRef: c.headRef } : {}) };
  return { ...job, sourceState: { ...job.sourceState, source: { ...job.sourceState?.source, pullRequest: url, seen } } };
}
