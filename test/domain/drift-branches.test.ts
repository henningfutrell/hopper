// Drift on the job repositories' default branches (issue #1077, the last part): the integration branch's health. Each
// default branch's head commit against its checks on GitHub — a branch the hopper merges jobs into must stay green.
//
// Feature: the default-branch-vs-checks comparison
//   Scenario: a default branch's checks failed
//   Scenario: a default branch's checks wait for too long
//   Scenario: checks that pass, a head in the grace, or a branch with no checks is no drift
import { describe, expect, it } from 'vitest';
import { BRANCH_CHECKS, branchChecksDrift, BRANCH_STUCK_MS, type BranchHead } from '../../src/domain/drift-branches.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';
const MINUTE_AGO = '2026-10-13T11:59:00.000Z';
const GRACE = 15 * 60_000;

const head = (repo: string, checks: BranchHead['checks'], committedAt = HOUR_AGO): BranchHead => ({ repo, committedAt, ...(checks ? { checks } : {}) });

describe('default-branch-vs-checks drift', () => {
  it('finds a default branch whose checks failed or errored', () => {
    expect(branchChecksDrift([head('o/a', 'failure'), head('o/b', 'error'), head('o/c', 'success')], NOW, GRACE)).toEqual([
      {
        watcher: BRANCH_CHECKS, kind: 'checks_failing', items: [
          { key: 'o/a', says: 'default branch head', truth: 'checks failed', since: HOUR_AGO },
          { key: 'o/b', says: 'default branch head', truth: 'checks errored', since: HOUR_AGO },
        ],
      },
    ]);
  });

  it('finds a default branch whose checks wait longer than the stuck time', () => {
    const old = new Date(Date.parse(NOW) - BRANCH_STUCK_MS - 60_000).toISOString();
    expect(branchChecksDrift([head('o/a', 'pending', old), head('o/b', 'expected', old), head('o/c', 'pending')], NOW, GRACE)).toEqual([
      {
        watcher: BRANCH_CHECKS, kind: 'checks_stuck', items: [
          { key: 'o/a', says: 'default branch head', truth: 'checks pending', since: old },
          { key: 'o/b', says: 'default branch head', truth: 'checks expected', since: old },
        ],
      },
    ]);
  });

  it('gives no drift for passing checks, a head in the grace, or a branch with no checks', () => {
    expect(branchChecksDrift([head('o/a', 'success'), head('o/b', 'failure', MINUTE_AGO), head('o/c', undefined), { repo: 'o/d' }], NOW, GRACE)).toEqual([]);
  });
});
