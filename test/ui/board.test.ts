// The overview's numbers, lists and lane board, all derived from the one job store (issue #45).
import { describe, expect, it } from 'vitest';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';
import { GROUP, canPark, canPickUp, canRerun, parkRefusal, startsFresh, jobBoard, kpis, rerunOutcome, laneName, laneRows, waitingRows } from '../../ui/src/model/board.ts';
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
    expect(b.operatorLed.map((j) => j.status)).toEqual(['operator_led']);
    expect(b.parked.map((j) => j.status)).toEqual(['parked']);
    expect(b.running.map((j) => j.status).sort()).toEqual(['claimed', 'running']);
    expect(b.ended.map((j) => j.status).sort()).toEqual(['cancelled', 'failed', 'finished', 'rejected']);
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
      waitingAnswer: b.waitingAnswer.length, parked: b.parked.length,
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

describe('Park and Re-queue (issue #501): offered only where the daemon takes them', () => {
  it('Park: a running job or one on a question, whose executor can park, with or without an agent session (issue #530)', () => {
    const offered = STATUSES.filter((status) => canPark(job(status, { status, spec: { executor: 'herdr-claude', payload: {} } }), ['herdr-claude']));
    expect(offered.sort()).toEqual(['running', 'waiting_answer']);
  });
  it('where Park cannot apply, says why: the status, or an executor that cannot park', () => {
    expect(parkRefusal(job('t', { status: 'waiting_answer' }), ['herdr-claude'])).toMatch(/executor test cannot park/);
    expect(parkRefusal(job('q', { status: 'queued', spec: { executor: 'herdr-claude', payload: {} } }), ['herdr-claude'])).toMatch(/queued/);
    expect(parkRefusal(job('h', { status: 'running', spec: { executor: 'herdr-claude', payload: {} } }), ['herdr-claude'])).toBeUndefined();
  });
  it('a parked job with no agent session starts fresh at its re-queue; one with a session resumes it', () => {
    expect(startsFresh(job('p', { status: 'parked' }))).toBe(true);
    expect(startsFresh(job('p', { status: 'parked', agentSession: 's' }))).toBe(false);
  });
  it('Re-queue: a parked job only', () => {
    expect(STATUSES.filter((status) => canPickUp(job(status, { status, agentSession: 's' })))).toEqual(['parked']);
  });
  it('a parked job is in no other group: never running, never waiting, never on a lane', () => {
    const b = jobBoard([job('p', { status: 'parked', resumeOn: 'm1' })], []);
    const k = kpis(b, [machine([lane('lane-1', 'idle')])]);
    expect([k.running, k.waiting, k.waitingAnswer, k.lanesBusy, k.parked]).toEqual([0, 0, 0, 0, 1]);
    expect(laneRows([machine([lane('lane-1', 'idle')])], b.running).every((r) => r.job === undefined)).toBe(true);
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

describe('canRerun (issues #313, #354, #362)', () => {
  const src = (key: string) => ({ source: { source: 'github', kind: 'github', key } }) as Partial<Job>;
  const reported = (o: Record<string, unknown> = {}) => ({ sourceState: { sync: { claimReported: true, finalReported: true, ...o } } }) as Partial<Job>;
  it('a failed job of a source, the newest of its item, its failure reported, can run again', () => {
    const failed = job('f', { status: 'failed', ...src('k'), ...reported() });
    expect(canRerun(failed, [failed, job('other', { status: 'failed', ...src('k2'), createdAt: '2026-10-03T11:00:00Z' })])).toBe(true);
  });
  it('a finished job whose result is not wanted can run again too (issue #354)', () => {
    const done = job('d', { status: 'finished', ...src('k'), ...reported() });
    expect(canRerun(done, [done])).toBe(true);
  });
  it('not once a newer job of its item exists, nor a job that did not end failed or finished, nor one of no source', () => {
    const failed = job('f', { status: 'failed', ...src('k'), ...reported() });
    expect(canRerun(failed, [failed, job('n', { status: 'queued', ...src('k'), createdAt: '2026-10-03T11:00:00Z' })])).toBe(false);
    expect(canRerun(job('c', { status: 'cancelled', ...src('k'), ...reported() }), [])).toBe(false);
    expect(canRerun(job('s', { status: 'failed', ...reported() }), [])).toBe(false);
  });
  it('not while its end is not reported to its source yet: the daemon refuses that', () => {
    expect(canRerun(job('f', { status: 'failed', ...src('k') }), [])).toBe(false);
    expect(canRerun(job('f', { status: 'failed', ...src('k'), ...reported({ finalReported: false }) }), [])).toBe(false);
  });
});

describe('rerunOutcome (issue #354)', () => {
  it('says where the new job is: waiting for acceptance, held and why, queued, or failed at once with its reason', () => {
    expect(rerunOutcome(job('n', { status: 'queued', accepted: false }))).toEqual({ ok: true, message: 'Queued again: waiting for acceptance in Queue' });
    expect(rerunOutcome(job('n', { status: 'held', holdReason: 'lane cap reached' }))).toEqual({ ok: true, message: 'Queued again, held: lane cap reached' });
    expect(rerunOutcome(job('n', { status: 'queued' }))).toEqual({ ok: true, message: 'Queued again' });
    expect(rerunOutcome(job('n', { status: 'failed', error: 'empty issue body' }))).toEqual({ ok: false, message: 'Run again: the new job failed at once: empty issue body' });
  });
});
