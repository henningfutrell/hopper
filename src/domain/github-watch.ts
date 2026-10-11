// GitHub watches (issue #427, design.md "GitHub watches"): one per pointed job that has not ended, polling its issue or
// pull request on the user's interval. A poll's snapshot — state, labels, comments, reviews, linked pull requests — is
// compared with the one stored before it; a difference is one `github_watch.changed` with every change of that poll, no
// difference is nothing. The first poll of a watch stores its snapshot and emits nothing: there is nothing to compare.
// Pure.
import type { PointedJob, Pointer } from './pointed-jobs.ts';

/** A comment on the item: GitHub's id (increasing), its author and when it was made. */
export interface WatchComment { id: number; author: string; at: string }

/** A review of a pull request: GitHub's id, its author, its state as GitHub says it (`approved`, `changes_requested`, `commented`, …). */
export interface WatchReview { id: number; author: string; state: string; at: string }

/** What one poll saw of the watched item. Labels and linked pull requests in any order: they compare as sets. */
export interface WatchSnapshot {
  /** `merged`: a pull request merged; else GitHub's state. */
  state: 'open' | 'closed' | 'merged';
  /** Why it was closed (GitHub's state_reason: `completed`, `not_planned`, …); absent: open, or not said. */
  stateReason?: string;
  mergedAt?: string;
  labels: string[];
  comments: WatchComment[];
  reviews: WatchReview[];
  /** The pull requests that reference the item (its timeline's cross-references), by URL. */
  linkedPullRequests: string[];
}

/** What changed between two snapshots: each part present only when it changed. */
export interface WatchChanges {
  state?: { from: WatchSnapshot['state']; to: WatchSnapshot['state']; reason?: string; mergedAt?: string };
  labels?: { added: string[]; removed: string[] };
  /** The comments added, and how many of those before are gone (deleted). */
  comments?: { added: WatchComment[]; removed: number };
  reviews?: { added: WatchReview[] };
  linkedPullRequests?: { added: string[]; removed: string[] };
}

const minus = (a: readonly string[], b: readonly string[]): string[] => [...new Set(a)].filter((x) => !b.includes(x)).sort();

function setChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } | undefined {
  const added = minus(after, before), removed = minus(before, after);
  return added.length || removed.length ? { added, removed } : undefined;
}

/** The changes from `before` to `after`; undefined when there is none. */
export function githubWatchChanges(before: WatchSnapshot, after: WatchSnapshot): WatchChanges | undefined {
  const c: WatchChanges = {};
  if (before.state !== after.state) {
    c.state = { from: before.state, to: after.state, ...(after.stateReason ? { reason: after.stateReason } : {}), ...(after.mergedAt ? { mergedAt: after.mergedAt } : {}) };
  }
  const labels = setChange(before.labels, after.labels);
  if (labels) c.labels = labels;
  const had = new Set(before.comments.map((x) => x.id)), has = new Set(after.comments.map((x) => x.id));
  const added = after.comments.filter((x) => !had.has(x.id)), removed = before.comments.filter((x) => !has.has(x.id)).length;
  if (added.length || removed) c.comments = { added, removed };
  const reviewed = new Set(before.reviews.map((r) => r.id));
  const reviews = after.reviews.filter((r) => !reviewed.has(r.id));
  if (reviews.length) c.reviews = { added: reviews };
  const linked = setChange(before.linkedPullRequests, after.linkedPullRequests);
  if (linked) c.linkedPullRequests = linked;
  return Object.keys(c).length ? c : undefined;
}

/** A pointed job is watched until it ends. */
export const watched = (job: PointedJob): boolean => job.status !== 'merged' && job.status !== 'abandoned';

/** The user's GitHub watch settings: how often each watch polls. */
export interface GitHubWatchSettings { intervalSeconds: number }

export const DEFAULT_GITHUB_WATCH: GitHubWatchSettings = { intervalSeconds: 60 };
export const GITHUB_WATCH_INTERVAL = { min: 10, max: 86_400 } as const;

/** The settings in force: the saved ones within their range, else the defaults. */
export function githubWatchSettingsOf(saved: Partial<GitHubWatchSettings> | undefined): GitHubWatchSettings {
  const s = saved?.intervalSeconds ?? DEFAULT_GITHUB_WATCH.intervalSeconds;
  return { intervalSeconds: Math.min(GITHUB_WATCH_INTERVAL.max, Math.max(GITHUB_WATCH_INTERVAL.min, Math.round(s))) };
}

/** A watch as stored: the last snapshot, when it was polled, and the last poll's problem (cleared by a good poll). */
export interface GitHubWatch {
  pointedJob: string;
  repo: string;
  pointer: Pointer;
  snapshot?: WatchSnapshot;
  polledAt?: string;
  /** When the snapshot last changed (the first poll included). */
  changedAt?: string;
  error?: string;
}

/** As GET /api/github-watches answers: the settings and every watch of a pointed job that has not ended. */
export interface GitHubWatchView { settings: GitHubWatchSettings; watches: GitHubWatch[] }

/** The watches' store (tenant migration 43): one per pointed job, kept after it ends for its last snapshot. */
export interface GitHubWatchRepository {
  get(pointedJob: string): GitHubWatch | undefined;
  put(watch: GitHubWatch): void;
}
