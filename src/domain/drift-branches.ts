// Drift on the job repositories' default branches (issue #1077, design.md "Component watchers"): the integration branch's
// health. The hopper merges jobs into each job repository's default branch, so a red one fails every job after it. Each
// default branch's head commit against its checks on GitHub (their rollup): checks that failed, or that wait for too
// long. A head committed in the grace is no drift yet: a re-run may still turn it green. Pure: no I/O, no clock.
import type { Drift, DriftItem } from './drift.ts';

export const BRANCH_CHECKS = 'branch-checks';

/** Checks that wait this long are stuck: no check of a commit takes two hours. */
export const BRANCH_STUCK_MS = 2 * 3_600_000;

/** What GitHub says of a default branch's head: when it was committed, and its checks' rollup; absent: it has none. */
export interface BranchHead { repo: string; committedAt?: string; checks?: 'success' | 'failure' | 'error' | 'pending' | 'expected' }

const FAILED: Record<string, string> = { failure: 'checks failed', error: 'checks errored' };
const WAITING = new Set(['pending', 'expected']);

/**
 * The drift of `heads`, one per kind, in the order given: `checks_failing` (the head's checks failed or errored, and it
 * was committed more than `graceMs` ago), `checks_stuck` (its checks wait, and it was committed more than `BRANCH_STUCK_MS` ago).
 */
export function branchChecksDrift(heads: readonly BranchHead[], now: string, graceMs: number): Drift[] {
  const at = Date.parse(now);
  const byKind = new Map<string, DriftItem[]>();
  const add = (kind: string, item: DriftItem) => byKind.set(kind, [...byKind.get(kind) ?? [], item]);
  for (const h of heads) {
    if (!h.checks) continue;
    const age = h.committedAt === undefined ? Infinity : at - Date.parse(h.committedAt);
    const item = (truth: string): DriftItem => ({ key: h.repo, says: 'default branch head', truth, ...(h.committedAt ? { since: h.committedAt } : {}) });
    if (FAILED[h.checks] && age > graceMs) add('checks_failing', item(FAILED[h.checks]!));
    else if (WAITING.has(h.checks) && age > BRANCH_STUCK_MS) add('checks_stuck', item(`checks ${h.checks}`));
  }
  return [...byKind].map(([kind, items]) => ({ watcher: BRANCH_CHECKS, kind, items }));
}
