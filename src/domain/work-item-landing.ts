// A work item's landing stage (issue #1073 part 3, design.md "Landing batches"): where a job's pull request merged into
// the landing branch stands on its way to the tested branch. `waiting` for a batch run, in a `batch_run`, `bisecting` in a
// red batch, the `culprit` of one, `reverted` from the landing branch, or `promoted` to the tested branch with its batch.
// Folded from the repository's `landing_batch.*` events into each item whose merged pull request they name (by number, in
// the event's repository), or whose batch tip they name. The item's state stays as the ledger says it (`done`): the stage
// is a fact beside it. Pure.
import type { DomainEvent, EventType } from './types.ts';
import type { WorkItem } from './work-items.ts';

export const LANDING_STAGES = ['waiting', 'batch_run', 'bisecting', 'culprit', 'reverted', 'promoted'] as const;
export type LandingStage = typeof LANDING_STAGES[number];

/** A work item's landing stage: its repository (lowercased), the stage, since when, and the batch it is in. */
export interface ItemLanding {
  repo: string;
  stage: LandingStage;
  since: string;
  /** The tip of the batch run (or the red batch) it is in. */
  tip?: string;
  /** The pull request of that batch run. */
  batch?: number;
  /** A culprit's revert, as a pull request into the landing branch. */
  revert?: number;
  /** A culprit's fix issue. */
  fixIssue?: string;
}

/** The `landing_batch.*` events the ledger reads. */
export const LANDING_LEDGER_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'landing_batch.pending', 'landing_batch.started', 'landing_batch.promoted', 'landing_batch.failed', 'landing_batch.bisect_started',
  'landing_batch.bisect_tested', 'landing_batch.culprit', 'landing_batch.revert_opened', 'landing_batch.reverted', 'landing_batch.fix_filed',
]);

/** A culprit or a reverted one: later batches name its merge again (the revert is a commit of its own), and move it no more. */
const STICKY: ReadonlySet<LandingStage> = new Set(['culprit', 'reverted']);

/** Whether the stage takes the item's change off the landing branch (issue #1175): the item is not done. */
export const isLandingUndone = (l: Pick<ItemLanding, 'stage'> | undefined): boolean => l !== undefined && STICKY.has(l.stage);

/** The stages of a merge on its way to the tested branch: it waits for a batch run, or is in one (issue #1175). */
const ON_ITS_WAY: ReadonlySet<LandingStage> = new Set(['waiting', 'batch_run', 'bisecting']);

/**
 * How long a merge no landing event named yet counts as on its way (issue #1175): the runner names it within a pass (2
 * minutes). One older is a merge from before the batches, whose open issue a person reopened.
 */
export const LANDING_UNSEEN_MS = 60 * 60_000;

/**
 * Whether the item waits on its batch (issue #1175): done by a pull request merged into the landing branch of a repository
 * with landing batches (`landingRepo`, by its lowercased `owner/name`), not yet promoted, a culprit or reverted. Its issue
 * stays open until its batch run reaches the tested branch, and Intake neither offers it again nor starts a job for it.
 */
export function awaitsBatch(item: Pick<WorkItem, 'state' | 'stateSince' | 'pullRequest' | 'pullRequestState' | 'landing'> | undefined,
  landingRepo: (repo: string) => boolean, now: number): boolean {
  const pr = pullRequestOf(item?.pullRequest);
  if (!item || !pr || item.state !== 'done' || item.pullRequestState !== 'merged' || !landingRepo(pr.repo)) return false;
  if (item.landing?.repo === pr.repo) return ON_ITS_WAY.has(item.landing.stage);
  return now - Date.parse(item.stateSince) <= LANDING_UNSEEN_MS;
}

/** An issue URL's `owner/name` (as written) and number. */
const issueOf = (url: string): { repo: string; number: number } | undefined => {
  const m = /\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

/**
 * The issues a batch run of `repo` closes (issue #1175), as GitHub's closing references from `repo`: `#N`, or
 * `owner/name#N` for an issue of another repository. Of the items done by a pull request of `merges` — not a part, a
 * culprit or a reverted one (none of those is `done`) —, those whose issue is not closed, in the order of `merges`.
 */
export function batchClosingIssues(items: Iterable<Pick<WorkItem, 'key' | 'state' | 'pullRequest' | 'pullRequestState' | 'issueState' | 'landing'>>,
  repo: string, merges: readonly number[]): string[] {
  const at = new Map<number, string[]>();
  for (const i of items) {
    const pr = pullRequestOf(i.pullRequest);
    const issue = issueOf(i.key);
    if (!pr || !issue || pr.repo !== repo.toLowerCase() || !merges.includes(pr.number)) continue;
    if (i.state !== 'done' || i.pullRequestState !== 'merged' || i.issueState === 'closed' || isLandingUndone(i.landing)) continue;
    const ref = issue.repo.toLowerCase() === repo.toLowerCase() ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
    at.set(pr.number, [...at.get(pr.number) ?? [], ref]);
  }
  const out: string[] = [];
  for (const n of merges) for (const ref of (at.get(n) ?? []).sort()) if (!out.includes(ref)) out.push(ref);
  return out;
}

/** The repository (lowercased) and number of a pull request's URL. */
export function pullRequestOf(url: string | undefined): { repo: string; number: number } | undefined {
  const m = url ? /\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return m ? { repo: m[1]!.toLowerCase(), number: Number(m[2]) } : undefined;
}

type LandingEvent = Pick<DomainEvent, 'type' | 'at' | 'data'>;

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []);

/** The pull requests an event names, of the job pull requests in a batch; the batch run's own is no job's. */
function namedPullRequests(e: LandingEvent): number[] {
  const d = e.data;
  if (e.type === 'landing_batch.pending' || e.type === 'landing_batch.started') return numbers(d.merges);
  if (e.type === 'landing_batch.bisect_started') return numbers((Array.isArray(d.points) ? d.points : []).map((p: { pullRequest?: unknown }) => p.pullRequest));
  if (e.type === 'landing_batch.culprit') return numbers([d.pullRequest]);
  if (e.type === 'landing_batch.revert_opened') return numbers([d.culpritPullRequest]);
  return [];
}

/** What a store looks for to find the items an event moves: the pull requests it names, and the tip of their batch. */
export function landingTargets(e: LandingEvent): { repo: string; pullRequests: number[]; tip?: string } | undefined {
  if (!LANDING_LEDGER_EVENTS.has(e.type) || typeof e.data.repo !== 'string') return undefined;
  return { repo: e.data.repo.toLowerCase(), pullRequests: namedPullRequests(e), ...(typeof e.data.tip === 'string' ? { tip: e.data.tip } : {}) };
}

/** The item after a landing event; undefined: the event does not move it. Only an item whose pull request merged is in a batch. */
export function applyLanding(item: WorkItem, e: LandingEvent): WorkItem | undefined {
  const t = landingTargets(e);
  const pr = pullRequestOf(item.pullRequest);
  if (!t || !pr || pr.repo !== t.repo || item.pullRequestState !== 'merged') return undefined;
  const was = item.landing?.repo === t.repo ? item.landing : undefined;
  const d = e.data;
  const named = t.pullRequests.includes(pr.number);
  const atTip = was !== undefined && t.tip !== undefined && was.tip === t.tip;
  const sticky = was !== undefined && STICKY.has(was.stage);
  const to = (stage: LandingStage, change: Partial<ItemLanding> = {}): WorkItem | undefined => {
    const next: ItemLanding = { ...(was ?? { repo: t.repo, stage, since: e.at }), ...change, stage, since: was?.stage === stage ? was.since : e.at };
    if (was && JSON.stringify(next) === JSON.stringify(was)) return undefined;
    return { ...item, landing: next, version: item.version + 1 };
  };
  switch (e.type) {
    case 'landing_batch.pending':
      return named && (!was || was.stage === 'waiting') ? to('waiting') : undefined;
    case 'landing_batch.started':
      return named && !sticky ? to('batch_run', { tip: t.tip, batch: typeof d.pullRequest === 'number' ? d.pullRequest : undefined }) : undefined;
    case 'landing_batch.promoted':
      return atTip && was.stage === 'batch_run' ? to('promoted') : undefined;
    case 'landing_batch.failed':
      return atTip && was.stage === 'batch_run' ? to('waiting') : undefined;
    case 'landing_batch.bisect_started':
      return named && !sticky ? to('bisecting', { tip: t.tip }) : undefined;
    case 'landing_batch.bisect_tested':
      return atTip && was.stage === 'bisecting' && d.outcome !== 'good' && d.outcome !== 'bad' ? to('waiting') : undefined;
    case 'landing_batch.culprit':
      if (named) return to('culprit', { tip: t.tip });
      return atTip && was.stage === 'bisecting' ? to('waiting') : undefined;
    case 'landing_batch.revert_opened':
      return named ? to('culprit', { tip: t.tip, revert: typeof d.pullRequest === 'number' ? d.pullRequest : undefined }) : undefined;
    case 'landing_batch.reverted':
      return atTip && was.stage === 'culprit' ? to('reverted') : undefined;
    case 'landing_batch.fix_filed':
      return atTip && sticky && typeof d.url === 'string' ? to(was.stage, { fixIssue: d.url }) : undefined;
    default:
      return undefined;
  }
}

/** One job pull request on its way from the landing branch to the tested branch: the Pull requests view's Landing list. */
export interface LandingCard {
  jobId?: string;
  repo: string;
  /** The work item's key: its issue's URL. */
  issue: string;
  pullRequest: { number: number; url: string };
  stage: LandingStage;
  since: string;
  batch?: number;
  revert?: number;
  fixIssue?: string;
}

/** How long a reverted one stays on the Landing list: a week. */
export const LANDING_REVERTED_SHOWN_MS = 7 * 24 * 60 * 60_000;

/** The Landing list: every item in motion (not promoted), and a reverted one for a week, the newest stage first. */
export function landingCards(items: readonly WorkItem[], now: number): LandingCard[] {
  const out: LandingCard[] = [];
  for (const i of items) {
    const l = i.landing;
    const pr = pullRequestOf(i.pullRequest);
    if (!l || !pr || l.stage === 'promoted') continue;
    if (l.stage === 'reverted' && now - Date.parse(l.since) > LANDING_REVERTED_SHOWN_MS) continue;
    out.push({
      ...(i.jobId ? { jobId: i.jobId } : {}), repo: l.repo, issue: i.key, pullRequest: { number: pr.number, url: i.pullRequest! },
      stage: l.stage, since: l.since, ...(l.batch !== undefined ? { batch: l.batch } : {}),
      ...(l.revert !== undefined ? { revert: l.revert } : {}), ...(l.fixIssue ? { fixIssue: l.fixIssue } : {}),
    });
  }
  return out.sort((a, b) => b.since.localeCompare(a.since) || a.issue.localeCompare(b.issue));
}
