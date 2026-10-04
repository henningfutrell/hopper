// The overview's numbers and the lane board, derived from /api/queue and /api/machines.
import { describe, expect, it } from 'vitest';
import type { Job, Lane } from '../../src/domain/types.ts';
import { kpis, laneRows, waitingRows } from '../../ui/src/model/board.ts';
import type { MachineView, Queue } from '../../ui/src/model/wire.ts';

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'running', approved: false,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 1, ...o,
} as Job);
const lane = (id: string, state: Lane['state'], jobId?: string): Lane => ({ id: `m1/${id}`, machineId: 'm1', state, jobId, openedAt: '2026-10-03T10:00:00Z' });
const machine = (lanes: Lane[], maxLanes = 3): MachineView => ({ id: 'm1', label: 'laptop', maxLanes, online: true, executors: ['test'], lanes, usage: [] });
const queue = (o: Partial<Queue> = {}): Queue => ({ waiting: [], running: [], waitingAnswer: [], ended: [], counts: {}, ...o });

describe('laneRows', () => {
  it('one row per open lane with its job, then unopened capacity up to maxLanes', () => {
    const a = job('a', { laneId: 'm1/lane-1' });
    const rows = laneRows([machine([lane('lane-1', 'busy', 'a'), lane('lane-2', 'idle')])], [a]);
    expect(rows.map((r) => [r.state, r.lane?.id ?? null, r.job?.id ?? null])).toEqual([
      ['busy', 'm1/lane-1', 'a'], ['idle', 'm1/lane-2', null], ['unopened', null, null],
    ]);
  });
  it('a draining lane stays draining; a running job no lane lists still shows', () => {
    const rows = laneRows([machine([lane('lane-1', 'draining', 'a')], 1)], [job('a'), job('b', { laneId: 'm9/lane-4' })]);
    expect(rows.map((r) => [r.state, r.job?.id])).toEqual([['draining', 'a'], ['busy', 'b']]);
    expect(rows[1]?.machine.id).toBe('m9');
  });
});

describe('kpis', () => {
  it('counts running with claimed, busy lanes, waiting with held, and the ended statuses', () => {
    const k = kpis(queue({ counts: { running: 2, claimed: 1, queued: 3, held: 2, waiting_answer: 1, finished: 7, failed: 2, cancelled: 1 } }),
      [machine([lane('lane-1', 'busy'), lane('lane-2', 'draining'), lane('lane-3', 'idle')], 4)]);
    expect(k).toEqual({ running: 3, lanesBusy: 2, lanesOpen: 3, lanesMax: 4, waiting: 5, held: 2, onQuestion: 1, finished: 7, failed: 2, cancelled: 1 });
  });
});

describe('waitingRows', () => {
  it('jobs on a question first, then waiting in decider order with the latest Decision effective priority', () => {
    const rows = waitingRows(
      queue({ waitingAnswer: [job('q', { status: 'waiting_answer' })], waiting: [job('w1', { status: 'queued' }), job('w2', { status: 'held' })] }),
      { start: [{ jobId: 'w2', effectivePriority: 70, laneId: null, machineId: 'm1', reason: 'r' }] },
    );
    expect(rows.map((r) => [r.job.id, r.kind, r.position, r.effectivePriority])).toEqual([
      ['q', 'question', null, null], ['w1', 'waiting', 1, null], ['w2', 'waiting', 2, 70],
    ]);
  });
});
