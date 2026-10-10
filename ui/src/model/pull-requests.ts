// The Pull requests view (issue #637), pure: the header lines, and the words for each card's checks, merge state and
// closing issue. The daemon builds the list; the UI only says it.
import type { PullRequestCard, PullRequestsView } from './wire.ts';

const prs = (n: number): string => `${n} ${n === 1 ? 'PR' : 'PRs'}`;

export const yoloLine = (v: PullRequestsView): string => `yolo: on for ${v.yolo.on} of ${v.yolo.total} repos`;

export function waitingLine(v: PullRequestsView): string {
  if (v.waiting.length === 0) return 'merging waits: nothing';
  return `merging waits: ${v.waiting.map((w) => `${prs(w.count)} in ${w.repo} (${w.reason})`).join(', ')}`;
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
  ? 'On: the hopper merges a ready pull request when its checks pass.'
  : 'Off: a ready pull request waits for a person to merge it.';

/** The body that turns yolo mode on or off for one repository. */
export const yoloToggle = (repo: string, on: boolean): { repos: Record<string, boolean> } => ({ repos: { [repo]: on } });

export const hasCards = (v: PullRequestsView): boolean => v.repos.some((r) => r.pullRequests.length > 0);
