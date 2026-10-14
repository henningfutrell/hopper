// The Pull requests view (issue #637), pure: the header lines, and the words for each card's checks, merge state and
// closing issue, and the repositories with no checks (issue #677). The daemon builds the list; the UI only says it.
import { ago } from './format.ts';
import type { LandingCard, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView } from './wire.ts';

type MergeWait = NonNullable<PullRequestCard['waits']>;

const prs = (n: number): string => `${n} ${n === 1 ? 'PR' : 'PRs'}`;

export const yoloLine = (v: PullRequestsView): string => `yolo: on for ${v.yolo.on} of ${v.yolo.total} repos`;

/** Why a card waits, in plain words (issue #677). */
const WAITS_TEXT: Record<MergeWait, string> = {
  'no pull request': 'no pull request found yet', tending: 'a job works on it now', 'tend failed': 'the job that worked on it failed: waiting for a person',
  'not checked yet': 'not checked yet', draft: 'draft',
  conflicts: 'conflicts with its base branch', 'checks failing': 'checks failed', 'yolo off': 'waiting for a person to merge',
  'checks pending': 'waiting for checks', 'checks unknown': 'the hopper cannot read its checks', 'checks not started': 'waiting for checks to start', 'merge refused': 'merge refused',
  'merge held': 'ready, waits for another pull request to merge first', ready: 'ready, merging',
};

export const waitsText = (c: Pick<PullRequestCard, 'waits' | 'base'>): string =>
  !c.waits ? '' : c.waits === 'conflicts' && c.base ? `conflicts with ${c.base}` : WAITS_TEXT[c.waits];

/**
 * What the hopper does about an open card now (issue #927), when no tend is queued or given up: its tend job's step, the
 * merge it waits to make, or nothing, and who acts then.
 */
const DOING_TEXT: Partial<Record<MergeWait, string>> = {
  'no pull request': 'the hopper looks for its pull request on each sync', 'not checked yet': 'the hopper reads it from GitHub on its next sync',
  'checks pending': 'the hopper merges it when its checks pass',
  'checks not started': 'the hopper merges it when its checks pass, or when no check starts within 2 minutes of its last push',
  ready: 'the hopper merges it on its next sync', 'merge refused': 'the hopper tries the merge again on each sync',
  'checks unknown': 'nothing: the hopper may not read its checks, so a person merges it',
  'yolo off': 'nothing: yolo mode is off, so a person merges it', draft: 'nothing: the hopper does not tend a draft, so a person marks it ready',
};

/**
 * What the hopper does about a card (issue #927): gave up, and why; tends it on its next sync, cannot tend it and why (issue
 * #967), or holds it behind another — since when at `now` (ms), and the tend job that holds it with its status (issue #1162);
 * its tend job's step, and why that job waits to start (issue #967); or what it waits to do. '' for a card that is not open.
 */
export function doingText(c: Pick<PullRequestCard, 'state' | 'waits' | 'base' | 'queue' | 'gaveUp' | 'tendJobId' | 'tendStep' | 'tendWaits'>, now?: number): string {
  if (c.gaveUp) return `the hopper gave up: ${c.gaveUp}`;
  if (c.queue) {
    if ('next' in c.queue) return `the hopper ${c.waits === 'checks failing' ? 'fixes its failed checks' : `rebases it onto ${c.base ?? 'its base branch'}`} on its next sync`;
    if ('refused' in c.queue) return `the hopper cannot tend it: ${c.queue.refused}`;
    const { pullRequest, why, since, holder } = c.queue.held;
    const age = since && now !== undefined ? ` since ${ago(since, now)}` : '';
    const by = holder ? `which job ${holder.jobId.slice(0, 8)} works on now (${holder.status.replace(/_/g, ' ')})` : 'which a job works on now';
    return `held behind #${pullRequest}${age}, ${why === 'tending' ? by : 'which the hopper merges first'}: they conflict`;
  }
  if (c.state !== 'open' || !c.waits) return '';
  if (c.waits === 'tending' && c.tendJobId) {
    const step = c.tendStep === 'fix_checks' ? 'fixes its failed checks' : `rebases it onto ${c.base ?? 'its base branch'}`;
    return `the hopper ${step}: job ${c.tendJobId.slice(0, 8)} ${c.tendWaits ? `waits to start: ${c.tendWaits}` : 'works on it now'}`;
  }
  return DOING_TEXT[c.waits] ?? '';
}

export function waitingLine(v: PullRequestsView): string {
  if (v.waiting.length === 0) return 'merging waits: nothing';
  return `merging waits: ${v.waiting.map((w) => `${prs(w.count)} in ${w.repo} (${WAITS_TEXT[w.reason]})`).join(', ')}`;
}

const CHECKS_TEXT: Record<PullRequestCard['checks'], string> = {
  passing: 'checks pass', pending: 'checks pending', failing: 'checks fail', none: 'no checks', unknown: 'checks not known',
};

/**
 * A card's checks in plain words (issue #938): with merge conflicts, no check runs on its head until the hopper rebases
 * it, so pending checks say that, never "pending".
 */
export const checksText = (c: Pick<PullRequestCard, 'checks' | 'mergeable'>): string =>
  c.mergeable === 'conflicts' && c.checks === 'pending' ? 'checks run after the rebase' : CHECKS_TEXT[c.checks];

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

/**
 * The open pull requests the hopper gave up on (issue #927), one line each: its repository and number, and why. They wait
 * on a person, so Needs you lists them.
 */
export const gaveUpLines = (v: PullRequestsView | undefined): string[] =>
  Array.isArray(v?.repos) ? v.repos.flatMap((r) => r.pullRequests.flatMap((c) =>
    c.state === 'open' && c.gaveUp ? [`${r.repo}#${c.pullRequest?.number ?? c.issue.number}: ${c.gaveUp}`] : [])) : [];

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

/** Where a job's pull request merged into the landing branch stands on its way to the tested branch (issue #1073). */
export function landingText(c: Pick<LandingCard, 'stage' | 'batch' | 'revert' | 'fixIssue'>): string {
  switch (c.stage) {
    case 'waiting': return 'merged into the landing branch: waits for a batch run';
    case 'batch_run': return c.batch !== undefined ? `in batch run #${c.batch}` : 'in a batch run';
    case 'bisecting': return 'its batch failed: a bisect tests it';
    case 'culprit': return c.revert !== undefined ? `it fails the full test suite: its revert #${c.revert} waits to merge` : 'it fails the full test suite: the hopper reverts it';
    case 'reverted': return `reverted${c.revert !== undefined ? ` by #${c.revert}` : ''}: ${c.fixIssue ? 'a fix issue is filed' : 'no fix issue yet'}`;
    case 'promoted': return 'on the tested branch';
  }
}
