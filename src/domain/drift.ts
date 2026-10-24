// Drift (issue #1077, design.md "Component watchers"): where a part of the hopper's state disagrees with its source of
// truth. The comparisons of the hopper's own records are in `drift-jobs.ts` and `drift-intake.ts`, of the default branches
// `drift-branches.ts`, of the stack `drift-stack.ts`. The ledger-vs-GitHub watcher's comparison is here: which work items it reads on GitHub (`ledgerGitHubSample`),
// and the drift it finds (`ledgerGitHubDrift`) — grouped by kind, so one kind is one drift issue. And the drift issue's
// text (`driftIssue`), which names no item: each is a short hash of its key, since an item's repository may be private.
// Pure: no I/O, no clock.
import { createHash } from 'node:crypto';
import { isActive, type WorkItem, type WorkItemState } from './work-items.ts';

/** What a read of GitHub says of one issue or pull request, by its URL. `changedAt`: when it closed or merged. */
export interface GitHubItemState { url: string; state: 'open' | 'closed' | 'merged'; stateReason?: string; changedAt?: string }

/** One item in a drift: its key (kept on this hopper only), what the component says, and what its source of truth says. */
export interface DriftItem { key: string; says: string; truth: string; since?: string }

/** One kind of drift a watcher found, with every item in it now. */
export interface Drift { watcher: string; kind: string; items: DriftItem[] }

/** The settings of the component watchers: whether a drift files a drift issue. Absent: never set, off. */
export interface ComponentWatcherSettings { fileIssues: boolean }
export const DEFAULT_COMPONENT_WATCHERS: ComponentWatcherSettings = { fileIssues: false };

/** One drift as the view shows it: its items with their keys (this hopper's own), and its issue. */
export interface DriftView { kind: string; items: number; list: DriftItem[]; since: string; issue?: { number: number; url: string } }
export interface ComponentWatcherView {
  name: string; component: string; truth: string; intervalSeconds: number;
  /** The instance's, not the user's (the stack): only the hopper's admin reads it. */
  instance?: true;
  checkedAt?: string; error?: string; issueError?: string; drifts: DriftView[];
}
export interface ComponentWatchersView { settings: ComponentWatcherSettings; watchers: ComponentWatcherView[] }

/** The view as a viewer reads it: an instance watcher only for the hopper's admin. */
export const viewFor = (v: ComponentWatchersView, instanceAdmin: boolean): ComponentWatchersView =>
  (instanceAdmin ? v : { ...v, watchers: v.watchers.filter((w) => !w.instance) });

/** The line of a drift issue's body that names its drift, so the next check finds the issue again. */
export const DRIFT_MARKER = 'Drift key: ';
export const driftKey = (d: Pick<Drift, 'watcher' | 'kind'>): string => `${d.watcher}/${d.kind}`;
/** An item as a drift issue names it: the first 12 hex digits of its key's SHA-256. */
export const driftItemRef = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 12);

export const LEDGER_GITHUB = 'ledger-github';

/** Each watcher in plain words, with the names of its two columns: the component and its source of truth. */
const WATCHER_WORDS: Record<string, { words: string; says: string; truth: string }> = {
  [LEDGER_GITHUB]: { words: 'ledger vs GitHub', says: 'ledger', truth: 'GitHub' },
  'ledger-jobs': { words: 'ledger vs jobs', says: 'ledger', truth: 'job record' },
  'lanes-jobs': { words: 'lanes vs jobs', says: 'lane', truth: 'job record' },
  'intake-jobs': { words: 'intake vs jobs', says: 'intake', truth: 'job record or sync timer' },
  'branch-checks': { words: 'default branches vs checks', says: 'branch', truth: 'checks' },
  'stack-health': { words: 'stack health', says: 'stack', truth: 'healthy stack' },
  'cleanup-jobs': { words: 'cleanup vs ended jobs', says: 'resource ledger', truth: 'job record' },
};
/** Each kind of drift in plain words. */
const KIND_WORDS: Record<string, string> = {
  failed_but_finished: 'failed in the ledger, finished on GitHub',
  pr_open_but_ended: 'pull request open in the ledger, ended on GitHub',
  pull_request_state: 'pull request state differs',
  issue_state: 'issue state differs',
  active_but_job_ended: 'active in the ledger, its job ended',
  ended_but_job_active: 'ended in the ledger, its job active',
  state_differs: 'the ledger state differs from its job',
  lane_busy_job_not_running: 'a lane is busy with a job that does not run',
  job_running_no_lane: 'a job runs with no lane',
  taken_no_job: 'taken by intake, with no job',
  sync_overdue: 'a source\'s next sync is overdue',
  sync_stuck: 'a source\'s sync runs too long',
  checks_failing: 'a default branch\'s checks fail',
  checks_stuck: 'a default branch\'s checks wait too long',
  service_down: 'a service of the stack is down or unhealthy',
  part_unreadable: 'a part of the stack does not answer',
  database_strain: 'the database is under strain',
  cleanup_mount: 'a cleanup failed: a file system is mounted in a dir',
  cleanup_process: 'a cleanup failed: a process still runs in a dir',
  cleanup_userns: 'a cleanup failed: files of a job\'s user namespace stay',
  cleanup_permission: 'a cleanup failed: the hopper\'s user may not remove files',
  cleanup_cause_unknown: 'a cleanup failed: its cause is not known (an older client)',
  cleanup_reap_failed: 'a cleanup failed: the reap did not run to its end',
};

/** The states in which an item can be stuck: read first. */
const STUCK: readonly WorkItemState[] = ['pr_open', 'failed', 'blocked', 'partly_done'];
/** A done or dropped item is read only this long after it got there. */
export const RECENT_MS = 7 * 24 * 3_600_000;
/** The most items one check reads. */
export const SAMPLE_LIMIT = 100;

const GITHUB_ITEM = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/;

/**
 * The issue and pull request URLs to read: of each item no job or person acts on, whose key is an issue's URL. Items in a
 * state they can be stuck in first, then the done and dropped ones of the last `recentMs`, newest first; at most `limit`.
 */
export function ledgerGitHubSample(items: readonly WorkItem[], now: string, o: { limit?: number; recentMs?: number } = {}): string[] {
  const since = new Date(Date.parse(now) - (o.recentMs ?? RECENT_MS)).toISOString();
  const read = items.filter((i) => !isActive(i.state) && GITHUB_ITEM.test(i.key) && (STUCK.includes(i.state) || i.stateSince >= since));
  const rank = (i: WorkItem) => (STUCK.includes(i.state) ? STUCK.indexOf(i.state) : STUCK.length);
  const picked = read.sort((a, b) => rank(a) - rank(b) || b.stateSince.localeCompare(a.stateSince)).slice(0, o.limit ?? SAMPLE_LIMIT);
  const urls = picked.flatMap((i) => [i.key, ...(i.pullRequest && GITHUB_ITEM.test(i.pullRequest) ? [i.pullRequest] : [])]);
  return [...new Set(urls)];
}

const githubWords = (r: GitHubItemState, kind: 'issue' | 'pull request'): string => (r.state === 'closed' && r.stateReason ? `${kind} closed (${r.stateReason})` : `${kind} ${r.state}`);
/** The ledger's pull request state as GitHub names it: an abandoned one is closed. */
const asGitHub = (s: string): string => (s === 'abandoned' ? 'closed' : s);

/**
 * The drift between the ledger and GitHub's `reads`, one per kind, items in the order given. An item a job or a person
 * acts on is no drift: the events win until they end. A close or a merge on GitHub newer than `graceMs` is no drift yet.
 */
export function ledgerGitHubDrift(items: readonly WorkItem[], reads: ReadonlyMap<string, GitHubItemState>, now: string, graceMs: number): Drift[] {
  const settledBefore = Date.parse(now) - graceMs;
  const old = (r: GitHubItemState | undefined): r is GitHubItemState => r !== undefined && (r.changedAt === undefined || Date.parse(r.changedAt) <= settledBefore);
  const byKind = new Map<string, DriftItem[]>();
  const add = (kind: string, item: DriftItem) => byKind.set(kind, [...byKind.get(kind) ?? [], item]);
  for (const i of items) {
    if (isActive(i.state)) continue;
    const issue = reads.get(i.key);
    const pr = i.pullRequest ? reads.get(i.pullRequest) : undefined;
    const at = (r: GitHubItemState) => (r.changedAt ? { since: r.changedAt } : {});
    const completed = old(issue) && issue.state === 'closed' && !['not_planned', 'duplicate'].includes(issue.stateReason ?? '');
    if (i.state === 'failed' && old(pr) && pr.state === 'merged') add('failed_but_finished', { key: i.key, says: i.state, truth: githubWords(pr, 'pull request'), ...at(pr) });
    else if (i.state === 'failed' && completed) add('failed_but_finished', { key: i.key, says: i.state, truth: githubWords(issue, 'issue'), ...at(issue) });
    else if (i.state === 'pr_open' && old(pr) && pr.state !== 'open') add('pr_open_but_ended', { key: i.key, says: i.state, truth: githubWords(pr, 'pull request'), ...at(pr) });
    else if (i.state === 'pr_open' && old(issue) && issue.state === 'closed') add('pr_open_but_ended', { key: i.key, says: i.state, truth: githubWords(issue, 'issue'), ...at(issue) });
    else if (i.pullRequestState && old(pr) && asGitHub(i.pullRequestState) !== pr.state) add('pull_request_state', { key: i.key, says: `${i.state}, pull request ${i.pullRequestState}`, truth: githubWords(pr, 'pull request'), ...at(pr) });
    else if (i.issueState && old(issue) && i.issueState !== issue.state) add('issue_state', { key: i.key, says: `${i.state}, issue ${i.issueState}`, truth: githubWords(issue, 'issue'), ...at(issue) });
  }
  return [...byKind].map(([kind, found]) => ({ watcher: LEDGER_GITHUB, kind, items: found }));
}

/** The most items a drift issue lists. */
export const ISSUE_ITEMS = 50;

/** A drift issue's title and body: what drifted, each item by its hash, and its drift key last. No item, repository or person. */
export function driftIssue(d: Drift, o: { firstSeen: string; clearedAt?: string }): { title: string; body: string } {
  const w = WATCHER_WORDS[d.watcher] ?? { words: d.watcher, says: 'hopper', truth: 'source of truth' };
  const watcher = w.words;
  const kind = KIND_WORDS[d.kind] ?? d.kind.replaceAll('_', ' ');
  const rows = d.items.slice(0, ISSUE_ITEMS).map((i) => `| \`${driftItemRef(i.key)}\` | ${i.says} | ${i.truth} | ${i.since ?? ''} |`);
  const more = d.items.length > ISSUE_ITEMS ? ['', `And ${d.items.length - ISSUE_ITEMS} more.`] : [];
  const items = d.items.length === 0
    ? [`No item is in this drift now${o.clearedAt ? ` (since ${o.clearedAt})` : ''}. Close this issue when the cause is fixed.`]
    : [`${d.items.length} item(s) disagree with the source of truth:`, '', `| item | ${w.says} | ${w.truth} | since |`, '|---|---|---|---|', ...rows, ...more];
  return {
    title: `Drift: ${watcher}: ${kind}`,
    body: [
      `A component watcher of a hopper found drift: ${watcher}, ${kind}.`, '',
      ...items, '',
      `First seen: ${o.firstSeen}. Each item is the first 12 hex digits of the SHA-256 of its key: the hopper's Settings → Component watchers lists the items.`, '',
      'Filed by a component watcher of a hopper. It updates this issue while the drift lasts.', '',
      `${DRIFT_MARKER}${driftKey(d)}`,
    ].join('\n'),
  };
}
