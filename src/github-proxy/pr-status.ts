// Where a pull request stands, as the hopper answers a job (issue #1072, design.md "Jobs ask the hopper, not GitHub"):
// from what the hopper already knows — the Pull requests list (what following the pull request last saw) and the
// work-item ledger —, so a job and the UI read one answer. Only a pull request it does not know is read on GitHub, as a
// repo query the repo-query cache keeps (repo-query.ts). Pure: no I/O, no clock.
import type { MergeWait, PullRequestCard } from '../domain/pull-request-list.ts';
import type { ChecksState, FailedCheck, PullRequestSeen } from '../domain/pull-requests.ts';
import type { WorkItem, WorkItemState } from '../domain/work-items.ts';

/** Where the pull request's work item stands in the ledger (issue #1067). */
export interface PullRequestItem { key: string; state: WorkItemState; waitingOn?: string }

/** A pull request's status, as `pr status` answers it. */
export interface PullRequestStatus {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  mergeable: 'mergeable' | 'conflicts' | 'unknown';
  /** Its head commit's checks: `none`, it has none; `unknown`, the hopper may not read them or has not. */
  checks: ChecksState | 'none';
  failedChecks: FailedCheck[];
  /** Why its checks are `unknown` when the hopper may not read them: the permission the connection lacks, and the fix (issue #1279). */
  checksWhy?: string;
  base?: string;
  head?: string;
  /** Why the hopper has not merged it yet, in the Pull requests list's words; absent when the hopper does not follow it open. */
  waits?: MergeWait;
  item?: PullRequestItem;
}

/** What the hopper knows of a pull request: its status, when it knows enough to answer; its work item, when one names it. */
export interface KnownPullRequest { known?: PullRequestStatus; item?: PullRequestItem }

export const itemOf = (i: WorkItem): PullRequestItem => ({ key: i.key, state: i.state, ...(i.waitingOn ? { waitingOn: i.waitingOn } : {}) });

/**
 * The status the hopper can answer from its records; undefined: it does not know enough, and GitHub is read. A card the
 * follow has seen answers as the Pull requests list shows it; a pull request the ledger says merged or closed answers its
 * end. A card not checked yet, or an open pull request only the ledger names, says nothing of its checks: GitHub is read.
 */
export function knownPullRequest(number: number, url: string, o: { card?: PullRequestCard; seen?: PullRequestSeen; item?: WorkItem }): PullRequestStatus | undefined {
  const item = o.item ? { item: itemOf(o.item) } : {};
  const { card, seen } = o;
  if (card && seen) {
    return {
      number, url, state: card.state === 'closed' ? 'closed' : 'open', draft: card.draft, mergeable: card.mergeable, checks: card.checks,
      failedChecks: seen.failedChecks ?? [], ...(card.checksWhy ? { checksWhy: card.checksWhy } : {}), ...(card.base ? { base: card.base } : {}), ...(seen.headRef ? { head: seen.headRef } : {}),
      ...(card.waits ? { waits: card.waits } : {}), ...item,
    };
  }
  const ended = o.item?.pullRequestState;
  if (ended === 'merged' || ended === 'closed' || ended === 'abandoned') {
    return { number, url, state: ended === 'merged' ? 'merged' : 'closed', draft: false, mergeable: 'unknown', checks: 'unknown', failedChecks: [], ...item };
  }
  return undefined;
}

/**
 * Whether a wait on a pull request's checks (`pr wait`, issue #1072 part 2) is over: its checks ended (passing, failing,
 * none, or checks the hopper may not read), or it is merged or closed. Only checks that run keep a job waiting.
 */
export const prSettled = (s: PullRequestStatus): boolean => s.state !== 'open' || s.checks !== 'pending';

/**
 * What a `pr wait` waits for (issue #1210): its checks to end (the default), or its mergeability to be other than `from`,
 * what it was when the wait opened — the next state the hopper sees, as the tend job of a pull request with conflicts
 * pushes.
 */
export type PrWaitOver = { for: 'checks' } | { for: 'mergeable'; from: PullRequestStatus['mergeable'] };

/** Whether the wait is over: the pull request merged or closed, or what it waits for came. A mergeability not known yet is no change. */
export function prWaitOver(s: PullRequestStatus, over: PrWaitOver): boolean {
  if (over.for === 'checks') return prSettled(s);
  return s.state !== 'open' || (s.mergeable !== 'unknown' && s.mergeable !== over.from);
}

/** Whether `url` is pull request `number` of `repo`, whatever the web origin and the case. */
export const isPullRequest = (url: string, repo: string, number: number): boolean =>
  url.toLowerCase().endsWith(`/${repo.toLowerCase()}/pull/${number}`);

/**
 * How `pr wait` answers on a pull request the hopper does not follow (issue #1731): no event of the hopper's tells it when the
 * checks end, so it opens no watch. Checks that ended: `settled`. Else `none`, with the `on:` line of a job's own wait on its
 * checks: the wait check reads that pull request on GitHub, in any repository (design.md "Wait checks").
 */
export function unfollowedWait(repo: string, number: number, read: Record<string, unknown>, over: PrWaitOver['for']): { wait: 'settled' | 'none'; waitOn?: string; note?: string } {
  if (over !== 'checks') return { wait: 'none' };
  if (read.state !== undefined && read.checks !== undefined && (read.state !== 'open' || read.checks !== 'pending')) return { wait: 'settled' };
  const waitOn = `pr ${repo}#${number} checks`;
  return {
    wait: 'none', waitOn,
    note: `The hopper does not follow this pull request, so pr wait cannot wait on it. To wait until its checks end, end your turn with HOPPER_WAITING and the line on: ${waitOn}. The hopper then reads the pull request and wakes you when its checks end.`,
  };
}
