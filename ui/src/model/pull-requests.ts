// The Pull requests view (issue #637), pure: the header lines, and the words for each card's checks, merge state and
// closing issue. The daemon builds the list; the UI only says it.
import type { PullRequestCard, PullRequestsView } from './wire.ts';

type MergeWait = NonNullable<PullRequestCard['waits']>;

const prs = (n: number): string => `${n} ${n === 1 ? 'PR' : 'PRs'}`;

export const yoloLine = (v: PullRequestsView): string => `yolo: on for ${v.yolo.on} of ${v.yolo.total} repos`;

/** Why a card waits, in plain words (issue #677). */
const WAITS_TEXT: Record<MergeWait, string> = {
  'no pull request': 'no pull request found yet', 'not checked yet': 'not checked yet', draft: 'draft',
  conflicts: 'conflicts with its base branch', 'checks failing': 'checks failed', 'yolo off': 'waiting for a person to merge',
  'checks pending': 'waiting for checks', 'checks not started': 'waiting for checks to start', 'merge refused': 'merge refused',
  ready: 'ready, merging',
};

export const waitsText = (c: Pick<PullRequestCard, 'waits' | 'base'>): string =>
  !c.waits ? '' : c.waits === 'conflicts' && c.base ? `conflicts with ${c.base}` : WAITS_TEXT[c.waits];

export function waitingLine(v: PullRequestsView): string {
  if (v.waiting.length === 0) return 'merging waits: nothing';
  return `merging waits: ${v.waiting.map((w) => `${prs(w.count)} in ${w.repo} (${WAITS_TEXT[w.reason]})`).join(', ')}`;
}

export const CHECKS_TEXT: Record<PullRequestCard['checks'], string> = {
  passing: 'checks pass', pending: 'checks pending', failing: 'checks fail', none: 'no checks', unknown: 'checks not seen yet',
};

export const MERGEABLE_TEXT: Record<PullRequestCard['mergeable'], string> = {
  mergeable: 'mergeable', conflicts: 'merge conflicts', unknown: 'merge state not seen yet',
};

export const closesText = (c: PullRequestCard): string => `${c.part ? 'part of' : 'closes'} #${c.issue.number}`;

/** What yolo mode does for a repository, on or off. */
export const yoloNote = (on: boolean): string => on
  ? 'On: the hopper merges a ready pull request when its checks pass, or when it has no checks.'
  : 'Off: a ready pull request waits for a person to merge it.';

/** The body that turns yolo mode on or off for one repository. */
export const yoloToggle = (repo: string, on: boolean): { repos: Record<string, boolean> } => ({ repos: { [repo]: on } });

export const hasCards = (v: PullRequestsView): boolean => v.repos.some((r) => r.pullRequests.length > 0);
