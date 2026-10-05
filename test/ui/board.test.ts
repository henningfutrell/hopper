// The overview's numbers, lists and lane board, all derived from the one job store (issue #45).
import { describe, expect, it } from 'vitest';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';
import { GROUP, jobBoard, kpis, laneName, laneRows, waitingRows } from '../../ui/src/model/board.ts';
import type { MachineView } from '../../ui/src/model/wire.ts';

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'running', approved: false,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 1, ...o,
} as Job);
const lane = (id: string, state: Lane['state'], jobId?: string): Lane => ({ id: `m1/${id}`, machineId: 'm1', state, jobId, openedAt: '2026-10-03T10:00:00Z' });
const machine = (lanes: Lane[], maxLanes = 3): MachineView => ({ id: 'm1', label: 'laptop', maxLanes, online: true, executors: ['test'], lanes, usage: [] });
const STATUSES = Object.keys(GROUP) as JobStatus[];

describe('jobBoard', () => {
  it('puts every job in exactly the group its status names: waiting is queued or held, never waiting_answer', () => {
    const jobs = STATUSES.map((status) => job(status, { status }));
    const b = jobBoard(jobs, []);
    expect(b.waiting.map((j) => j.status).sort()).toEqual(['held', 'queued']);
    expect(b.waitingAnswer.map((j) => j.status)).toEqual(['waiting_answer']);
    expect(b.running.map((j) => j.status).sort()).toEqual(['claimed', 'running']);
    expect(b.ended.map((j) => j.status).sort()).toEqual(['cancelled', 'failed', 'finished']);
    expect(Object.values(b).flat()).toHaveLength(STATUSES.length);
  });
  it('waiting in the queue order, ended newest end first, running oldest first', () => {
    const b = jobBoard([
      job('w1', { status: 'queued' }), job('w2', { status: 'held' }), job('w3', { status: 'queued' }),
      job('e1', { status: 'finished', finishedAt: '2026-10-03T11:00:00Z' }), job('e2', { status: 'failed', finishedAt: '2026-10-03T12:00:00Z' }),
      job('r1', { createdAt: '2026-10-03T09:00:00Z' }), job('r2', { status: 'claimed', createdAt: '2026-10-03T10:30:00Z' }),
    ], ['w2', 'w1']);
    expect(b.waiting.map((j) => j.id)).toEqual(['w2', 'w1', 'w3']);
    expect(b.ended.map((j) => j.id)).toEqual(['e2', 'e1']);
    expect(b.running.map((j) => j.id)).toEqual(['r1', 'r2']);
  });
});

describe('kpis', () => {
  it('every count is the length of the list it names, for any mix of statuses', () => {
    const jobs = STATUSES.flatMap((status, i) => Array.from({ length: i + 1 }, (_, n) => job(`${status}-${n}`, { status })));
    const b = jobBoard(jobs, []);
    const k = kpis(b, [machine([lane('lane-1', 'busy'), lane('lane-2', 'draining'), lane('lane-3', 'idle')], 4)]);
    expect(k).toEqual({
      running: b.running.length, waiting: b.waiting.length, held: b.waiting.filter((j) => j.status === 'held').length,
      waitingAnswer: b.waitingAnswer.length,
      finished: b.ended.filter((j) => j.status === 'finished').length, failed: b.ended.filter((j) => j.status === 'failed').length,
      cancelled: b.ended.filter((j) => j.status === 'cancelled').length,
      lanesBusy: 2, lanesOpen: 3, lanesMax: 4,
    });
  });
  it('one job on a question and nothing queued: waiting 0, waiting answer 1 (issue #45)', () => {
    const b = jobBoard([job('q', { status: 'waiting_answer' })], []);
    const k = kpis(b, []);
    expect([k.waiting, k.waitingAnswer]).toEqual([0, 1]);
    expect(waitingRows(b, undefined)).toEqual([]);
  });
});

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

describe('laneName (issue #166)', () => {
  const on = (id: string, label: string): MachineView => ({ ...machine([]), id, label });
  it('names the machine with every lane: two machines with the same label never read the same lane-1', () => {
    const ms = [on('m1', 'laptop'), on('m2', 'laptop')];
    expect(laneName('m1/lane-1', ms)).toBe('laptop (m1) · lane-1');
    expect(laneName('m2/lane-1', ms)).toBe('laptop (m2) · lane-1');
  });
  it('a machine labelled with its own id, or no longer listed, is named by its id once', () => {
    expect(laneName('local/lane-2', [on('local', 'local')])).toBe('local · lane-2');
    expect(laneName('m9/lane-4', [])).toBe('m9 · lane-4');
  });
  it('a lane row carries the work tree of the job it runs', () => {
    const rows = laneRows([machine([lane('lane-1', 'busy', 'a'), lane('lane-2', 'idle')], 2)], [job('a', { workTree: '/w/repo' })]);
    expect(rows.map((r) => r.workTree)).toEqual(['/w/repo', undefined]);
  });
});

describe('waitingRows', () => {
  it('waiting jobs in queue order with the latest Decision effective priority', () => {
    const b = jobBoard([job('w1', { status: 'queued' }), job('w2', { status: 'held' })], ['w1', 'w2']);
    const rows = waitingRows(b, { start: [{ jobId: 'w2', effectivePriority: 70, laneId: null, machineId: 'm1', reason: 'r' }] });
    expect(rows.map((r) => [r.job.id, r.position, r.effectivePriority])).toEqual([['w1', 1, null], ['w2', 2, 70]]);
  });
});
