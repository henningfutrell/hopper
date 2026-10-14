// Issue #1073 part 4: merge conflicts between the landing branch and the tested branch, fixed by the hopper. A batch run
// with merge conflicts says the tested branch has a change the landing branch lacks. The hopper merges the tested branch
// into a branch at the landing tip (a **back-merge**) and lands it on the landing branch; the next batch run starts at
// once. A real conflict files one issue, so Intake takes it. Pure.
//
// Feature: the back-merge — its state, when a batch run starts, and its text
//   Scenario: a back-merge opened, then merged: the next batch run starts at once, and a filed issue is cleared
//   Scenario: a back-merge at work holds the next batch run
//   Scenario: a real conflict: failed with conflict; the issue filed is kept until a batch run is promoted
//   Scenario: the branch, the pull request text and the issue text are neutral and say what to do
import { describe, expect, it } from 'vitest';
import { backMergeBody, backMergeBranch, backMergeIssueText, backMergeTitle } from '../../src/domain/landing-back-merge.ts';
import { batchDue, landingBatchStates, type LandingBatchRepo } from '../../src/domain/landing-batches.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const CFG: LandingBatchRepo = { tested: 'dev', everyMerges: 3, everyMinutes: 60 };
const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = ago(0)): DomainEvent =>
  ({ seq: ++seq, id: `e${seq}`, type, at, data, v: 1 }) as unknown as DomainEvent;
const T1 = 'a1a1a1a1a1a1a1a1a1a1';
const started = (tip: string, n: number, at: number) => ev('landing_batch.started', { repo: REPO, landing: 'main', tested: 'dev', tip, branch: `hopper-batch/${tip}`, pullRequest: n, url: `u${n}`, merges: [3] }, ago(at));
const conflicted = (tip: string, n: number, at: number) => ev('landing_batch.failed', { repo: REPO, tested: 'dev', tip, pullRequest: n, url: `u${n}`, reason: 'the batch has merge conflicts with the tested branch', checks: [] }, ago(at));

describe('the back-merge state (issue #1073 part 4)', () => {
  it('opened, then merged: the next batch run starts at once', () => {
    const open = [
      started(T1, 9, 30), conflicted(T1, 9, 20),
      ev('landing_batch.back_merge_opened', { repo: REPO, landing: 'main', tested: 'dev', tip: T1, batch: 9, branch: backMergeBranch(T1), merge: 'm1', pullRequest: 11, url: 'u11' }, ago(20)),
    ];
    const s = landingBatchStates(open)[REPO]!;
    expect(s.backMerge).toMatchObject({ tip: T1, state: 'open', pullRequest: 11 });
    expect(batchDue(s, { tip: 'a2', aheadBy: 5, merges: 1 }, CFG, NOW)).toEqual({ due: false, why: 'the merge of dev into the landing branch (#11) waits to merge' });

    const merged = landingBatchStates([...open, ev('landing_batch.back_merged', { repo: REPO, tip: T1, pullRequest: 11, url: 'u11', merge: 'm2' }, ago(10))])[REPO]!;
    expect(merged.backMerge).toMatchObject({ state: 'merged' });
    expect(batchDue(merged, { tip: 'a2', aheadBy: 5, merges: 1 }, CFG, NOW)).toEqual({ due: true, why: 'dev was merged into the landing branch' });

    const ran = landingBatchStates([...open, ev('landing_batch.back_merged', { repo: REPO, tip: T1, pullRequest: 11, url: 'u11' }, ago(10)), started('a2', 12, 5)])[REPO]!;
    expect(ran.backMergedSinceRun).toBeUndefined();
  });

  it('a real conflict: failed with conflict; the issue filed stays until a batch run is promoted', () => {
    const failed = [
      started(T1, 9, 30), conflicted(T1, 9, 20),
      ev('landing_batch.back_merge_failed', { repo: REPO, tip: T1, batch: 9, conflict: true, reason: 'dev conflicts with main' }, ago(20)),
      ev('landing_batch.back_merge_issue_filed', { repo: REPO, tip: T1, issue: 40, url: 'i40' }, ago(19)),
    ];
    const s = landingBatchStates(failed)[REPO]!;
    expect(s.backMerge).toMatchObject({ tip: T1, state: 'failed', conflict: true, batch: 9, reason: 'dev conflicts with main' });
    expect(s.backMergeIssue).toEqual({ tip: T1, issue: 40, url: 'i40' });
    // A red batch for conflicts, with nothing new since: no run.
    expect(batchDue(s, { tip: T1, aheadBy: 5, merges: 1 }, CFG, NOW).due).toBe(false);

    const later = landingBatchStates([...failed, started('a2', 13, 10), conflicted('a2', 13, 9)])[REPO]!;
    expect(later.backMergeIssue).toMatchObject({ issue: 40 });
    const promoted = landingBatchStates([...failed, started('a3', 14, 5), ev('landing_batch.promoted', { repo: REPO, tested: 'dev', tip: 'a3', pullRequest: 14, url: 'u14' }, ago(1))])[REPO]!;
    expect(promoted.backMergeIssue).toBeUndefined();
  });
});

describe('the back-merge text (issue #1073 part 4)', () => {
  const b = { landing: 'main', tested: 'dev', tip: T1, batch: 9 };

  it('names the branch by the landing tip, under the batch prefix no job pushes to', () => {
    expect(backMergeBranch(T1)).toBe('hopper-batch/back-merge-a1a1a1a1a1a1');
  });

  it('writes a neutral pull request text', () => {
    expect(backMergeTitle(b)).toBe('Merge dev into main at a1a1a1a1a1a1');
    const body = backMergeBody(b);
    expect(body).toContain('#9');
    expect(body).toContain('`dev`');
    expect(body).toContain('Do not merge it by hand.');
  });

  it('writes an issue that says what to do', () => {
    const t = backMergeIssueText(b);
    expect(t.title).toBe('Resolve the merge conflicts of dev with main');
    expect(t.body).toContain('#9');
    expect(t.body).toContain('Merge `dev` into it');
    expect(t.body).toContain('pull request into `main`');
  });
});
