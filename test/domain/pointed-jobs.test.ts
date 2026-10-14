// Issue #425: the pointed job's transitions, and how a job the hopper already has reads as a pointed job.
import { describe, expect, it } from 'vitest';
import { canMove, POINTED_JOB_STATUSES, pointedJobOf, TRANSITIONS } from '../../src/domain/pointed-jobs.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const job = (status: JobStatus, follow?: string, over: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Fix it' }, priority: 50, status, approved: true, attempts: 1,
  createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T11:00:00.000Z',
  source: { source: 'github', kind: 'github', key: 'https://github.com/o/r/issues/3', url: 'https://github.com/o/r/issues/3', repo: 'o/r', number: 3, title: 'The title' },
  ...(follow ? { sourceState: { source: { follow } } } : {}),
  ...over,
});

describe('pointed job transitions', () => {
  it('allows the lifecycle, and nothing out of merged or abandoned', () => {
    expect(canMove('queued', 'running')).toBe(true);
    expect(canMove('running', 'awaiting_review')).toBe(true);
    expect(canMove('awaiting_review', 'merged')).toBe(true);
    expect(canMove('awaiting_review', 'running')).toBe(true);
    expect(canMove('running', 'queued')).toBe(true);
    for (const s of POINTED_JOB_STATUSES) if (s !== 'merged' && s !== 'abandoned') expect(canMove(s, 'abandoned'), s).toBe(true);
    expect(canMove('queued', 'merged')).toBe(false);
    expect(canMove('queued', 'queued')).toBe(false);
    expect(TRANSITIONS.merged).toEqual([]);
    expect(TRANSITIONS.abandoned).toEqual([]);
  });
});

describe('a job as a pointed job', () => {
  it('points at its issue, with its goal as directive, its lane and its source', () => {
    expect(pointedJobOf(job('running', undefined, { laneId: 'm/lane-2' }))).toEqual({
      id: 'j1', jobId: 'j1', repo: 'o/r', pointer: { kind: 'issue', number: 3, url: 'https://github.com/o/r/issues/3' },
      directive: 'Fix it', lane: 'm/lane-2', status: 'running', source: 'github', createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T11:00:00.000Z',
    });
  });

  it('takes the title when the job has no goal, and leaves out a job of no repository', () => {
    expect(pointedJobOf(job('queued', undefined, { spec: { executor: 'test', payload: {} } }))?.directive).toBe('The title');
    expect(pointedJobOf(job('queued', undefined, { source: { source: 'manual', kind: 'manual', key: 'k' } }))).toBeUndefined();
    expect(pointedJobOf(job('queued', undefined, { source: undefined }))).toBeUndefined();
  });

  it.each([
    ['queued', undefined, 'queued'], ['held', undefined, 'queued'], ['parked', undefined, 'queued'], ['rejected', undefined, 'abandoned'],
    ['claimed', undefined, 'running'], ['running', undefined, 'running'], ['waiting_answer', undefined, 'running'],
    ['waiting_on', undefined, 'running'], ['operator_led', undefined, 'running'],
    ['finished', undefined, 'merged'], ['finished', 'merged', 'merged'], ['finished', 'open', 'awaiting_review'],
    ['finished', 'tended', 'awaiting_review'], ['finished', 'reworked', 'awaiting_review'], ['finished', 'closed', 'abandoned'],
    ['failed', undefined, 'abandoned'], ['failed', 'open', 'awaiting_review'], ['failed', 'merged', 'merged'], ['cancelled', undefined, 'abandoned'],
  ] as const)('%s, following %s: %s', (status, follow, want) => {
    expect(pointedJobOf(job(status, follow))?.status).toBe(want);
  });
});
