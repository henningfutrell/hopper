// The charts' data: ended jobs per time bucket, and what each lane ran when.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { concurrency, laneSpans, questionWaits, throughput } from '../../ui/src/model/history.ts';

const T0 = Date.parse('2026-10-03T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (type: EventType, min: number, o: Partial<DomainEvent> = {}): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: String(seq), type, at: at(min), data: {}, ...o });
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'running', approved: false,
  createdAt: at(-120), updatedAt: at(-120), attempts: 1, ...o,
} as Job);
const store = (...jobs: Job[]) => new Map(jobs.map((j) => [j.id, j]));

describe('throughput', () => {
  it('buckets ended jobs by status at their end, oldest first, the last bucket holding now; older ones fall outside', () => {
    const ended = [
      job('a', { status: 'finished', finishedAt: at(-125) }), job('b', { status: 'finished', finishedAt: at(-61) }),
      job('c', { status: 'failed', finishedAt: at(-59) }), job('d', { status: 'cancelled', finishedAt: at(-1) }),
    ];
    const b = throughput(ended, T0 + 30_000, 60 * 60_000, 3);
    expect(b.map((x) => [x.start, x.finished, x.failed, x.cancelled])).toEqual([
      [T0 - 120 * 60_000, 1, 0, 0], [T0 - 60 * 60_000, 0, 1, 1], [T0, 0, 0, 0],
    ]);
  });
});

describe('laneSpans', () => {
  it('a span per job run on a lane: started → its end, outcome named; unended spans of running jobs are running', () => {
    const events = [
      ev('job.started', -50, { jobId: 'a', laneId: 'm/lane-1' }),
      ev('job.started', -40, { jobId: 'b', laneId: 'm/lane-2' }),
      ev('job.finished', -30, { jobId: 'a' }),
      ev('question.asked', -20, { jobId: 'b' }),
      ev('job.started', -10, { jobId: 'b', laneId: 'm/lane-1' }),
      ev('job.reattached', -5, { jobId: 'c', laneId: 'm/lane-2' }),
    ];
    expect(laneSpans(events, T0 - 60 * 60_000, store(job('a', { status: 'finished' }), job('b'), job('c')))).toEqual([
      { laneId: 'm/lane-1', jobId: 'a', start: T0 - 50 * 60_000, end: T0 - 30 * 60_000, outcome: 'finished' },
      { laneId: 'm/lane-2', jobId: 'b', start: T0 - 40 * 60_000, end: T0 - 20 * 60_000, outcome: 'question' },
      { laneId: 'm/lane-1', jobId: 'b', start: T0 - 10 * 60_000, end: null, outcome: 'running' },
      { laneId: 'm/lane-2', jobId: 'c', start: T0 - 5 * 60_000, end: null, outcome: 'running' },
    ]);
  });
  it('drops spans that ended before the window; failed, cancelled and requeued end a span', () => {
    const events = [
      ev('job.started', -90, { jobId: 'old', laneId: 'm/lane-1' }), ev('job.failed', -80, { jobId: 'old' }),
      ev('job.started', -50, { jobId: 'x', laneId: 'm/lane-1' }), ev('job.cancelled', -45, { jobId: 'x' }),
      ev('job.started', -40, { jobId: 'y', laneId: 'm/lane-1' }), ev('job.requeued', -35, { jobId: 'y' }),
    ];
    expect(laneSpans(events, T0 - 60 * 60_000, store()).map((s) => [s.jobId, s.outcome])).toEqual([['x', 'cancelled'], ['y', 'requeued']]);
  });
  it('a run started again with no end logged for the earlier one ends that one at the restart: no bar stays running (issue #181)', () => {
    const events = [
      ev('job.started', -2000, { jobId: 'a', laneId: 'm/lane-1' }),
      ev('job.started', -30, { jobId: 'a', laneId: 'm/lane-1' }),
      ev('job.finished', -10, { jobId: 'a' }),
    ];
    expect(laneSpans(events, T0 - 24 * 60 * 60_000, store(job('a', { status: 'finished', finishedAt: at(-10) })))).toEqual([
      { laneId: 'm/lane-1', jobId: 'a', start: T0 - 2000 * 60_000, end: T0 - 30 * 60_000, outcome: 'requeued' },
      { laneId: 'm/lane-1', jobId: 'a', start: T0 - 30 * 60_000, end: T0 - 10 * 60_000, outcome: 'finished' },
    ]);
  });
  it('the job store wins over the event log: an open span of a job no longer running ends with it (issue #45)', () => {
    const events = [ev('job.started', -50, { jobId: 'a', laneId: 'm/lane-1' }), ev('job.started', -40, { jobId: 'q', laneId: 'm/lane-2' }), ev('job.started', -30, { jobId: 'gone', laneId: 'm/lane-2' })];
    const spans = laneSpans(events, T0 - 60 * 60_000, store(
      job('a', { status: 'failed', finishedAt: at(-20) }), job('q', { status: 'waiting_answer', updatedAt: at(-35) }),
    ));
    expect(spans.map((s) => [s.jobId, s.end, s.outcome])).toEqual([['a', T0 - 20 * 60_000, 'failed'], ['q', T0 - 35 * 60_000, 'question']]);
  });
  it('a running job the event log holds no start for still gets its running span', () => {
    const spans = laneSpans([], T0 - 60 * 60_000, store(job('r', { laneId: 'm/lane-3', startedAt: at(-15) }), job('w', { status: 'queued' })));
    expect(spans).toEqual([{ laneId: 'm/lane-3', jobId: 'r', start: T0 - 15 * 60_000, end: null, outcome: 'running' }]);
  });
});

describe('questionWaits', () => {
  it('a job sits on its question on the lane it asked from, from the ask until the answer; one still asked is open', () => {
    const events = [
      ev('job.started', -50, { jobId: 'a', laneId: 'm/lane-1' }),
      ev('question.asked', -40, { jobId: 'a', laneId: 'm/lane-1' }),
      ev('job.started', -35, { jobId: 'b', laneId: 'm/lane-1' }),
      ev('question.asked', -30, { jobId: 'b', laneId: 'm/lane-1' }),
      ev('question.answered', -20, { jobId: 'a' }),
      ev('job.started', -15, { jobId: 'a', laneId: 'm/lane-2' }),
    ];
    expect(questionWaits(events, T0 - 60 * 60_000, store(job('a'), job('b', { status: 'waiting_answer' })))).toEqual([
      { laneId: 'm/lane-1', jobId: 'a', start: T0 - 40 * 60_000, end: T0 - 20 * 60_000, how: 'answered' },
      { laneId: 'm/lane-1', jobId: 'b', start: T0 - 30 * 60_000, end: null, how: 'waiting' },
    ]);
  });
  it('closed, dismissed and expired end a wait; so does the job starting again (answered in its pane)', () => {
    const events = [
      ev('job.started', -59, { jobId: 'c', laneId: 'm/lane-1' }), ev('question.asked', -58, { jobId: 'c' }), ev('question.closed', -57, { jobId: 'c' }),
      ev('job.started', -56, { jobId: 'd', laneId: 'm/lane-1' }), ev('question.asked', -55, { jobId: 'd' }), ev('question.dismissed', -54, { jobId: 'd' }),
      ev('job.started', -53, { jobId: 'e', laneId: 'm/lane-1' }), ev('question.asked', -52, { jobId: 'e' }), ev('question.expired', -51, { jobId: 'e' }),
      ev('job.started', -50, { jobId: 'p', laneId: 'm/lane-1' }), ev('question.asked', -49, { jobId: 'p' }), ev('job.started', -48, { jobId: 'p', laneId: 'm/lane-1' }),
    ];
    expect(questionWaits(events, T0 - 60 * 60_000, store(job('c'), job('d'), job('e'), job('p'))).map((w) => [w.jobId, w.how])).toEqual([
      ['c', 'closed'], ['d', 'dismissed'], ['e', 'expired'], ['p', 'answered'],
    ]);
  });
  it('a wait asked before the window that is still open shows; one ended before it does not', () => {
    const events = [
      ev('job.started', -200, { jobId: 'old', laneId: 'm/lane-1' }), ev('question.asked', -190, { jobId: 'old' }),
      ev('job.started', -180, { jobId: 'done', laneId: 'm/lane-1' }), ev('question.asked', -170, { jobId: 'done' }), ev('question.answered', -160, { jobId: 'done' }),
    ];
    expect(questionWaits(events, T0 - 60 * 60_000, store(job('old', { status: 'waiting_answer' }), job('done')))).toEqual([
      { laneId: 'm/lane-1', jobId: 'old', start: T0 - 190 * 60_000, end: null, how: 'waiting' },
    ]);
  });
  it('the job store wins: a job no longer waiting ends its wait with its last change, one it no longer holds has none, and a job it says waits but whose ask the log lacks waits from its run\'s end', () => {
    const events = [
      ev('job.started', -50, { jobId: 'x', laneId: 'm/lane-1' }), ev('question.asked', -45, { jobId: 'x' }),
      ev('job.started', -40, { jobId: 'gone', laneId: 'm/lane-1' }), ev('question.asked', -35, { jobId: 'gone' }),
      ev('job.started', -30, { jobId: 'w', laneId: 'm/lane-2' }),
    ];
    expect(questionWaits(events, T0 - 60 * 60_000, store(
      job('x', { status: 'cancelled', updatedAt: at(-25) }), job('w', { status: 'waiting_answer', updatedAt: at(-20) }),
    ))).toEqual([
      { laneId: 'm/lane-1', jobId: 'x', start: T0 - 45 * 60_000, end: T0 - 25 * 60_000, how: 'dismissed' },
      { laneId: 'm/lane-2', jobId: 'w', start: T0 - 20 * 60_000, end: null, how: 'waiting' },
    ]);
  });
});

describe('concurrency', () => {
  it('how many spans overlap each bucket, buckets aligned as throughput', () => {
    const spans = [
      { laneId: 'l1', jobId: 'a', start: T0 - 50 * 60_000, end: T0 - 25 * 60_000, outcome: 'finished' as const },
      { laneId: 'l2', jobId: 'b', start: T0 - 40 * 60_000, end: null, outcome: 'running' as const },
    ];
    expect(concurrency(spans, T0, 20 * 60_000, 3)).toEqual([2, 1, 1]);
  });
});
