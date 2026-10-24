// No pull request found is no resting state (issue #2693): an item whose finished job named no pull request, and none came
// a moment after, runs again by itself — its ended job's Run again, by the item reconciler —, `NO_PR_RUNS_AGAIN` times in a
// row. The ledger counts the ends in a row with no pull request (`noPullRequestEnds`); a pull request, a merge or a done end
// ends the row. Only past that is a person asked.
import { describe, expect, it } from 'vitest';
import { BLOCKED_NO_PR_MS, blockedStuck, correctionOf, NO_PR_RUNS_AGAIN } from '../../src/domain/item-lifecycle.ts';
import { applyEvent, type LedgerJob, type WorkItem } from '../../src/domain/work-items.ts';
import type { EventType } from '../../src/domain/types.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';
const T0 = '2026-10-13T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const item = (o: Partial<WorkItem>): WorkItem => ({ key: KEY, state: 'blocked', stateSince: T0, eventState: 'blocked', eventAt: T0, keptWork: [], version: 1, jobId: 'j1', blockedCause: 'no_pr', ...o });
const ended = { id: 'j1', status: 'finished', ended: true, updatedAt: T0 };

let minute = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}) => ({ type, at: `2026-10-18T11:${String(minute++).padStart(2, '0')}:00.000Z`, data });
const job = (id: string, pullRequest?: string): LedgerJob => ({ id, key: KEY, kind: 'github', ...(pullRequest ? { pullRequest } : {}) });

describe('an item whose job ended with no pull request runs again by itself (issue #2693)', () => {
  it('runs again once its report had time to name one, and no person is asked', () => {
    const blocked = item({});
    expect(correctionOf(blocked, ended, false, at(5))).toBeUndefined();
    expect(BLOCKED_NO_PR_MS).toBe(10 * 60_000);
    expect(correctionOf(blocked, ended, false, at(10))).toEqual({ kind: 'run_again', key: KEY, jobId: 'j1', cause: 'no_pr' });
    expect(blockedStuck(blocked, at(10))).toBe(false);
    // Its report named one since: folded again, not run again.
    expect(correctionOf(blocked, { ...ended, pullRequest: PR }, false, at(10))).toEqual({ kind: 'replay', key: KEY, jobId: 'j1', from: 'blocked' });
    // Not its newest job, or a job still at work: nothing.
    expect(correctionOf(blocked, { ...ended, id: 'j0' }, false, at(10))).toBeUndefined();
    expect(correctionOf(blocked, { ...ended, status: 'running', ended: false }, false, at(10))).toBeUndefined();
  });

  it('past the runs again in a row, a person is asked once', () => {
    const many = item({ noPullRequestEnds: NO_PR_RUNS_AGAIN + 1 });
    expect(correctionOf(item({ noPullRequestEnds: NO_PR_RUNS_AGAIN }), ended, false, at(10))).toMatchObject({ kind: 'run_again', cause: 'no_pr' });
    expect(correctionOf(many, ended, false, at(10))).toEqual({ kind: 'ask', key: KEY, cause: 'no_pr', jobId: 'j1' });
    expect(blockedStuck(many, at(10))).toBe(true);
    expect(correctionOf({ ...many, personAsked: true }, ended, false, at(10))).toBeUndefined();
  });

  it('the ledger counts the ends in a row with no pull request; one with a pull request ends the row', () => {
    let i = applyEvent(undefined, ev('job.queued'), KEY, job('j1'))!;
    i = applyEvent(i, ev('job.finished', { result: 'pull request ready for review' }), KEY, job('j1'))!;
    expect(i).toMatchObject({ state: 'blocked', blockedCause: 'no_pr', noPullRequestEnds: 1 });
    // The reconciler's replay of the same end is no second end.
    i = applyEvent(i, ev('work_item.reconciled', { key: KEY, from: 'blocked', jobId: 'j1', replay: { type: 'job.finished', data: { result: 'pull request ready for review' } } }), KEY, job('j1'))!;
    expect(i.noPullRequestEnds).toBe(1);
    i = applyEvent(i, ev('job.queued'), KEY, job('j2'))!;
    expect(i).toMatchObject({ state: 'queued', noPullRequestEnds: 1 });
    i = applyEvent(i, ev('job.finished', { result: 'pull request ready for review' }), KEY, job('j2'))!;
    expect(i).toMatchObject({ state: 'blocked', blockedCause: 'no_pr', noPullRequestEnds: 2 });
    i = applyEvent(i, ev('job.queued'), KEY, job('j3', PR))!;
    i = applyEvent(i, ev('job.finished', { result: 'pull request ready for review' }), KEY, job('j3', PR))!;
    expect(i).toMatchObject({ state: 'pr_open', pullRequest: PR });
    expect(i.noPullRequestEnds).toBeUndefined();
  });
});
