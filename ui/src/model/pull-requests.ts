// The Pull requests view (issue #637), pure: the header lines, and the words for each card's checks, merge state and
// closing issue, and the repositories with no checks (issue #677). The daemon builds the list; the UI only says it.
import type { PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView } from './wire.ts';

type MergeWait = NonNullable<PullRequestCard['waits']>;

const prs = (n: number): string => `${n} ${n === 1 ? 'PR' : 'PRs'}`;

export const yoloLine = (v: PullRequestsView): string => `yolo: on for ${v.yolo.on} of ${v.yolo.total} repos`;

/** Why a card waits, in plain words (issue #677). */
const WAITS_TEXT: Record<MergeWait, string> = {
  'no pull request': 'no pull request found yet', tending: 'a job works on it now', 'tend failed': 'the job that worked on it failed: waiting for a person',
  'not checked yet': 'not checked yet', draft: 'draft',
  conflicts: 'conflicts with its base branch', 'checks failing': 'checks failed', 'yolo off': 'waiting for a person to merge',
  'checks pending': 'waiting for checks', 'checks unknown': 'the hopper cannot read its checks', 'checks not started': 'waiting for checks to start', 'merge refused': 'merge refused',
  ready: 'ready, merging',
};

export const waitsText = (c: Pick<PullRequestCard, 'waits' | 'base'>): string =>
  !c.waits ? '' : c.waits === 'conflicts' && c.base ? `conflicts with ${c.base}` : WAITS_TEXT[c.waits];

export function waitingLine(v: PullRequestsView): string {
  if (v.waiting.length === 0) return 'merging waits: nothing';
  return `merging waits: ${v.waiting.map((w) => `${prs(w.count)} in ${w.repo} (${WAITS_TEXT[w.reason]})`).join(', ')}`;
}

export const CHECKS_TEXT: Record<PullRequestCard['checks'], string> = {
  passing: 'checks pass', pending: 'checks pending', failing: 'checks fail', none: 'no checks', unknown: 'checks not known',
};

export const MERGEABLE_TEXT: Record<PullRequestCard['mergeable'], string> = {
  mergeable: 'mergeable', conflicts: 'merge conflicts', unknown: 'merge state not seen yet',
};

export const closesText = (c: PullRequestCard): string => `${c.part ? 'part of' : 'closes'} #${c.issue.number}`;

/** What Merge now and Close PR ask before they act (issue #677). */
export const mergeQuestion = (c: PullRequestCard): string => `Merge #${c.pullRequest?.number} into ${c.base ?? 'its base branch'} now?`;
export const closeQuestion = (c: PullRequestCard): string => `Close #${c.pullRequest?.number} without a merge?`;

/** What yolo mode does for a repository, on or off. */
export const yoloNote = (on: boolean): string => on
  ? 'On: the hopper merges a ready pull request when its checks pass, or when it has no checks.'
  : 'Off: a ready pull request waits for a person to merge it.';


/** The open pull requests with merge conflicts (issue #897): each waits for a person to fix or close it. None for no answer. */
export const conflictedPullRequests = (v: PullRequestsView | undefined): number =>
  Array.isArray(v?.repos) ? v.repos.reduce((n, r) => n + r.pullRequests.filter((c) => c.state === 'open' && c.mergeable === 'conflicts').length, 0) : 0;

/** The header's line for them; '' when none. */
export const conflictsLine = (n: number): string =>
  n === 0 ? '' : `${n} ${n === 1 ? 'pull request has' : 'pull requests have'} merge conflicts: fix ${n === 1 ? 'it' : 'them'}, or close ${n === 1 ? 'it' : 'them'}`;

export const hasCards = (v: PullRequestsView): boolean => v.repos.some((r) => r.pullRequests.length > 0);

/** The header's warning (issue #677): every job repository with no checks; '' when none. */
export function noChecksLine(v: RepoChecksView): string {
  const none = (v.repos ?? []).filter((r) => r.state === 'no checks');
  if (none.length === 0) return '';
  return `no checks: ${none.map((r) => r.repo).join(', ')}${none.some((r) => r.yolo) ? ' (yolo merges unverified code there)' : ''}`;
}

/** A repository group's warning when it has no checks (issue #677). */
export const noChecksNote = (r: Pick<RepoChecks, 'yolo'>): string => r.yolo
  ? 'No checks: yolo mode merges unverified code here.'
  : 'No checks: nothing verifies a pull request here before a person merges it.';
