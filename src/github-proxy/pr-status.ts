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
 * A failing answer from the records with its checks as GitHub reads them now (issue #2321): the follow's last read can be of a
 * head a push replaced since, or of a run a newer run of its check superseded. `read` is `pr status` read on GitHub: the
 * checks of the head as it is now, the newest run of each check. What the follow read of a failed check (`reported`) stays
 * with the same run, by its URL. A `checks failing` wait the read does not bear out is dropped. No checks in `read`: `known`.
 */
export function withReadChecks(known: PullRequestStatus, read: Record<string, unknown>): PullRequestStatus {
  const r = read as Partial<PullRequestStatus>;
  if (r.checks === undefined) return known;
  const before = new Map(known.failedChecks.filter((c) => c.url).map((c) => [c.url!, c]));
  const failedChecks = (r.failedChecks ?? []).map((c) => (c.url && before.get(c.url)?.reported ? { ...c, reported: before.get(c.url)!.reported! } : c));
  const { checksWhy: _why, waits, ...rest } = known;
  const keepWaits = waits && !(waits === 'checks failing' && r.checks !== 'failing');
  return { ...rest, checks: r.checks, failedChecks, ...(r.checksWhy ? { checksWhy: r.checksWhy } : {}), ...(keepWaits ? { waits } : {}) };
}

/**
 * Whether the records' answer is of a pull request a tend job works on, or worked on and failed (issue #2497): its job
 * follows it no more (`follow: tended`, issue #736), so what the records saw is from before the tend — merge conflicts the
 * tend job's push removed, checks of a head it replaced. Nothing tells the hopper when it changes.
 */
export const tendedAnswer = (s: PullRequestStatus): boolean => s.waits === 'tending' || s.waits === 'tend failed';

/**
 * A tended pull request's answer from the records with what GitHub reads now (issue #2497): its state, draft, merge
 * conflicts and checks are the read's; the card's wait and the work item stay. A read with no state: `known`.
 */
export function withReadPullRequest(known: PullRequestStatus, read: Record<string, unknown>): PullRequestStatus {
  const r = read as Partial<PullRequestStatus>;
  if (r.state === undefined) return known;
  const checked = withReadChecks(known, read);
  return { ...checked, state: r.state, draft: r.draft ?? known.draft, mergeable: r.mergeable ?? known.mergeable };
}

/** Why `pr wait --for mergeable` opens no watch on a tended pull request (issue #2497). */
export const TENDED_WAIT_NOTE = 'A tend job works on this pull request, so the hopper does not follow it now: no event tells the hopper when its merge '
  + 'conflicts change. This answer is read on GitHub. Ask pr status again after a push, or check the merge with git merge-tree.';

/**
 * Whether a wait on a pull request's checks (`pr wait`, issue #1072 part 2) is over: its checks ended (passing, failing, or
 * checks the hopper may not read), or it is merged or closed. Checks that run keep a job waiting, and so do no checks
 * (issue #2322): right after a push, GitHub has not made the head's check runs yet, and they start queued.
 */
export const prSettled = (s: PullRequestStatus): boolean => s.state !== 'open' || (s.checks !== 'pending' && s.checks !== 'none');

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
 * How `pr wait` answers when the hopper opens no watch (issue #1731): on a pull request it does not follow, no event of the
 * hopper's tells it when the checks end; on one with no checks (issue #2322), none tells it when they start. Checks that
 * ended: `settled`. Else `none`, with the `on:` line of a job's own wait on its checks: the wait check reads that pull request
 * on GitHub, in any repository, holds while its checks run or have not started after its last commit, and wakes the job when
 * they end (design.md "Wait checks").
 */
export function unwatchedWait(repo: string, number: number, read: Record<string, unknown>, over: PrWaitOver['for']): { wait: 'settled' | 'none'; waitOn?: string; note?: string } {
  if (over !== 'checks') return { wait: 'none' };
  if (read.state !== undefined && read.checks !== undefined && prSettled(read as unknown as PullRequestStatus)) return { wait: 'settled' };
  const waitOn = `pr ${repo}#${number} checks`;
  const why = read.checks === 'none'
    ? 'Its head commit has no checks yet: they can start a short time after a push, so pr wait cannot wait on it.'
    : 'The hopper does not follow this pull request, so pr wait cannot wait on it.';
  return {
    wait: 'none', waitOn,
    note: `${why} To wait until its checks end, end your turn with HOPPER_WAITING and the line on: ${waitOn}. The hopper then reads the pull request and wakes you when its checks end.`,
  };
}
