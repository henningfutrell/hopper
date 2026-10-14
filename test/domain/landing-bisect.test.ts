// Issue #1073 part 2: a red batch. When a batch run's checks fail, the hopper bisects within the batch: the landing
// branch's first-parent commits since the tested branch are the batch's points, and each bisect run tests one of them.
// The first point that fails is the culprit: the hopper reverts it from the landing branch and files a fix issue that
// Intake takes like any other. Pure.
//
// Feature: a red batch — bisect, culprit, revert, fix issue
//   Scenario: the batch's points are the landing branch's first-parent commits beyond the tested branch, oldest first
//   Scenario: the bisect tests the middle point; a point that passes moves the good end, one that fails the bad end
//   Scenario: one point left between the good and the bad end is the culprit; a batch of one point needs no run
//   Scenario: the bisect and the culprit are reduced from their events; a revert merged since the last batch run starts the next one at once
//   Scenario: a bisect at work, or a revert that waits, holds the next batch run
//   Scenario: the issue a pull request closes is read from its body
//   Scenario: the fix issue's text is neutral: the culprit, its issue, the revert, the failing checks with their output, the bisect
//   Scenario: a check's output is cut to its last lines, with secrets and addresses masked
import { describe, expect, it } from 'vitest';
import { batchDue, landingBatchStates, type LandingBatchRepo } from '../../src/domain/landing-batches.ts';
import {
  batchPoints, bisectBranch, bisectNext, fixIssueText, linkedIssue, logTail, revertText, type Bisect,
} from '../../src/domain/landing-bisect.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const CFG: LandingBatchRepo = { tested: 'dev', everyMerges: 3, everyMinutes: 60 };
const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = ago(0)): DomainEvent =>
  ({ seq: ++seq, id: `e${seq}`, type, at, data, v: 1 }) as unknown as DomainEvent;

const bisect = (o: Partial<Bisect> = {}): Bisect => ({
  tip: 'p4', tested: 'dev', points: [{ sha: 'p1', pullRequest: 11 }, { sha: 'p2', pullRequest: 12 }, { sha: 'p3' }, { sha: 'p4', pullRequest: 14 }],
  good: -1, bad: 3, checks: { 3: [{ name: 'test', id: 7 }] }, reason: 'checks failed: test', startedAt: ago(10), results: [], ...o,
});

describe('the batch\'s points (issue #1073)', () => {
  it('are the first-parent commits from the tip back to the tested branch, oldest first, with the pull request a merge names', () => {
    const commits = [
      { sha: 'a1', parents: ['base', 'x1'], message: 'Merge pull request #11 from owner/issue-1' },
      { sha: 'x1', parents: ['base'], message: 'Add a (#1)' },
      { sha: 'b2', parents: ['a1'], message: 'Fix a typo' },
      { sha: 'y1', parents: ['base'], message: 'Add b' },
      { sha: 'c3', parents: ['b2', 'y1'], message: 'Merge pull request #12 from owner/issue-2\n\nAdd b' },
    ];
    expect(batchPoints(commits, 'c3')).toEqual([{ sha: 'a1', pullRequest: 11 }, { sha: 'b2' }, { sha: 'c3', pullRequest: 12 }]);
  });
});

describe('the bisect (issue #1073)', () => {
  it('tests the middle point first', () => {
    expect(bisectNext(bisect())).toEqual({ kind: 'test', index: 1 });
  });

  it('a point that passed moves the good end, one that failed the bad end; one point left is the culprit', () => {
    expect(bisectNext(bisect({ good: 1 }))).toEqual({ kind: 'test', index: 2 });
    expect(bisectNext(bisect({ good: 1, bad: 2 }))).toEqual({ kind: 'culprit', index: 2 });
    expect(bisectNext(bisect({ bad: 0 }))).toEqual({ kind: 'culprit', index: 0 });
  });

  it('a batch of one point needs no bisect run', () => {
    expect(bisectNext(bisect({ points: [{ sha: 'p1', pullRequest: 11 }], bad: 0 }))).toEqual({ kind: 'culprit', index: 0 });
  });

  it('names a bisect run\'s branch under the batch prefix, so no job pushes to it', () => {
    expect(bisectBranch('0123456789abcdef0123')).toBe('hopper-batch/bisect-0123456789ab');
  });
});

describe('a red batch\'s state, from its events (issue #1073)', () => {
  const started = { repo: REPO, tested: 'dev', tip: 'p4', points: [{ sha: 'p1', pullRequest: 11 }, { sha: 'p2', pullRequest: 12 }, { sha: 'p4', pullRequest: 14 }], checks: [{ name: 'test', id: 7 }], reason: 'checks failed: test', pullRequest: 100, url: 'u100' };

  it('a bisect started, ran a point, and moved its ends by the results', () => {
    const states = landingBatchStates([
      ev('landing_batch.failed', { repo: REPO, tested: 'dev', tip: 'p4', pullRequest: 100, url: 'u100', reason: 'checks failed: test', checks: ['test'] }, ago(30)),
      ev('landing_batch.bisect_started', started, ago(30)),
      ev('landing_batch.bisect_run', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', branch: 'hopper-batch/bisect-p2', pullRequest: 101, url: 'u101' }, ago(29)),
    ]);
    expect(states[REPO]!.bisect).toMatchObject({ tip: 'p4', good: -1, bad: 2, checks: { 2: [{ name: 'test', id: 7 }] }, running: { index: 1, sha: 'p2', pullRequest: 101 } });
    const after = landingBatchStates([
      ev('landing_batch.bisect_started', started, ago(30)),
      ev('landing_batch.bisect_run', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', branch: 'hopper-batch/bisect-p2', pullRequest: 101, url: 'u101' }, ago(29)),
      ev('landing_batch.bisect_tested', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', pullRequest: 101, url: 'u101', outcome: 'bad', checks: [{ name: 'test', id: 9 }] }, ago(20)),
    ]);
    expect(after[REPO]!.bisect).toMatchObject({ good: -1, bad: 1, checks: { 1: [{ name: 'test', id: 9 }] }, results: [{ index: 1, sha: 'p2', outcome: 'bad' }] });
    expect(after[REPO]!.bisect!.running).toBeUndefined();
  });

  it('a run with no verdict ends the bisect with its reason', () => {
    const states = landingBatchStates([
      ev('landing_batch.bisect_started', started, ago(30)),
      ev('landing_batch.bisect_tested', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', pullRequest: 101, url: 'u101', outcome: 'unknown', reason: 'no check ran in 30 minutes' }, ago(20)),
    ]);
    expect(states[REPO]!.bisect).toBeUndefined();
    expect(states[REPO]!.bisectEnded).toEqual({ tip: 'p4', reason: 'no check ran in 30 minutes', at: ago(20) });
  });

  it('a culprit ends the bisect; its revert and its fix issue are kept on it; a merged revert is when the culprit left', () => {
    const states = landingBatchStates([
      ev('landing_batch.bisect_started', started, ago(30)),
      ev('landing_batch.culprit', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', pullRequest: 12, checks: [{ name: 'test', id: 9 }], reason: 'checks failed: test', results: [] }, ago(20)),
      ev('landing_batch.revert_opened', { repo: REPO, tip: 'p4', sha: 'p2', culpritPullRequest: 12, pullRequest: 102, url: 'u102' }, ago(19)),
      ev('landing_batch.fix_filed', { repo: REPO, tip: 'p4', sha: 'p2', issue: 103, url: 'u103' }, ago(19)),
    ]);
    expect(states[REPO]!.bisect).toBeUndefined();
    expect(states[REPO]!.culprit).toMatchObject({ tip: 'p4', sha: 'p2', pullRequest: 12, revert: { pullRequest: 102, url: 'u102', state: 'open' }, fix: { issue: 103, url: 'u103' } });
    const merged = landingBatchStates([
      ev('landing_batch.culprit', { repo: REPO, tested: 'dev', tip: 'p4', index: 1, sha: 'p2', pullRequest: 12, checks: [], reason: 'checks failed: test', results: [] }, ago(20)),
      ev('landing_batch.revert_opened', { repo: REPO, tip: 'p4', sha: 'p2', culpritPullRequest: 12, pullRequest: 102, url: 'u102' }, ago(19)),
      ev('landing_batch.reverted', { repo: REPO, tip: 'p4', sha: 'p2', pullRequest: 102, url: 'u102', merge: 'm9' }, ago(15)),
    ]);
    expect(merged[REPO]).toMatchObject({ culprit: { revert: { state: 'merged' } }, revertedSinceRun: true });
    const failed = landingBatchStates([
      ev('landing_batch.culprit', { repo: REPO, tested: 'dev', tip: 'p4', index: 0, sha: 'p1', checks: [], reason: 'checks failed: test', results: [] }, ago(20)),
      ev('landing_batch.revert_failed', { repo: REPO, tip: 'p4', sha: 'p1', reason: 'the culprit is a direct commit, not a pull request: revert it by hand' }, ago(19)),
    ]);
    expect(failed[REPO]!.culprit!.revertProblem).toBe('the culprit is a direct commit, not a pull request: revert it by hand');
  });

  it('a bisect at work, or a revert that waits, holds the next batch run; a merged revert starts it at once', () => {
    const facts = { tip: 'p5', aheadBy: 6, merges: 9 };
    const base = { repo: REPO, lastTestedTip: 'p4', lastStartedAt: ago(5) };
    expect(batchDue({ ...base, bisect: bisect() }, facts, CFG, NOW)).toEqual({ due: false, why: 'a bisect of the batch at p4 is at work' });
    const culprit = { tip: 'p4', sha: 'p2', pullRequest: 12, checks: [], reason: 'r', at: ago(4), results: [] };
    expect(batchDue({ ...base, culprit }, facts, CFG, NOW)).toEqual({ due: false, why: 'the revert of #12 is not open yet' });
    expect(batchDue({ ...base, culprit: { ...culprit, revert: { pullRequest: 102, url: 'u', state: 'open' as const } } }, facts, CFG, NOW))
      .toEqual({ due: false, why: 'the revert #102 of #12 waits to merge' });
    const reverted = { ...base, culprit: { ...culprit, revert: { pullRequest: 102, url: 'u', state: 'merged' as const } }, revertedSinceRun: true };
    expect(batchDue(reverted, { tip: 'p5', aheadBy: 6, merges: 1 }, CFG, NOW)).toEqual({ due: true, why: 'the culprit #12 was reverted' });
    expect(batchDue({ ...base, culprit: { ...culprit, revertProblem: 'closed' } }, { tip: 'p5', aheadBy: 6, merges: 1 }, CFG, NOW).due).toBe(false);
  });
});

describe('the culprit\'s text (issue #1073)', () => {
  it('reads the issue a pull request closes or is part of', () => {
    expect(linkedIssue('Closes #1073\n\nmore')).toBe(1073);
    expect(linkedIssue('Part of #712')).toBe(712);
    expect(linkedIssue('fixes #5')).toBe(5);
    expect(linkedIssue('No link here, see #4 for context')).toBeUndefined();
  });

  it('writes the revert\'s text: what it reverts and why, naming no person', () => {
    const t = revertText({ landing: 'main', tested: 'dev', tip: '0123456789abcdef', culprit: 12, checks: ['test'], batch: 100 });
    expect(t.title).toBe('Revert #12: it fails the full test suite');
    expect(t.body).toContain('#12');
    expect(t.body).toContain('#100');
    expect(t.body).toContain('`main`');
  });

  it('writes the fix issue: the culprit, its issue, the revert, each failing check with its output, the bisect', () => {
    const t = fixIssueText({
      landing: 'main', tested: 'dev', tip: '0123456789abcdef', sha: 'fedcba9876543210', pullRequest: 12, issue: 3,
      revert: { pullRequest: 102 }, batch: 100,
      checks: [{ name: 'test', log: 'FAIL test/a.test.ts\nexpected 1 to be 2' }, { name: 'shard (2)' }],
      results: [{ index: 1, sha: 'fedcba9876543210', outcome: 'bad' }, { index: 0, sha: 'aaaaaaaaaaaaaaaa', outcome: 'good' }],
    });
    expect(t.title).toBe('Fix the full test suite after #12');
    expect(t.body).toContain('#12');
    expect(t.body).toContain('#3');
    expect(t.body).toContain('#102');
    expect(t.body).toContain('expected 1 to be 2');
    expect(t.body).toContain('shard (2)');
    expect(t.body).toContain('aaaaaaaaaaaa: passed');
    expect(t.body).toContain('fedcba987654: failed');
    const direct = fixIssueText({ landing: 'main', tested: 'dev', tip: '0123456789abcdef', sha: 'fedcba9876543210', revert: { problem: 'the culprit is a direct commit' }, batch: 100, checks: [], results: [] });
    expect(direct.title).toBe('Fix the full test suite after fedcba987654');
    expect(direct.body).toContain('the culprit is a direct commit');
  });

  it('cuts a check\'s output to its last lines, and masks secrets and addresses', () => {
    const log = [...Array.from({ length: 100 }, (_, i) => `line ${i}`), 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'from 10.1.2.3'].join('\n');
    const tail = logTail(log, 10);
    expect(tail.split('\n')).toHaveLength(10);
    expect(tail).not.toContain('line 50');
    expect(tail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(tail).not.toContain('10.1.2.3');
  });
});
