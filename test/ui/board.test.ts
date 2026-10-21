// The dashboard's numbers, lists and lane board, all derived from the one job store (issue #45).
import { describe, expect, it } from 'vitest';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';
import { GROUP, ownWaitOf, waitCheckText, waitOnLink, waitOnLinkOf, canPark, canPickUp, canRerun, parkRefusal, startsFresh, jobBoard, kpis, lanesSub, laneJobState, laneName, laneRows, overCap, waitingRows } from '../../ui/src/model/board.ts';
import type { MachineLaneEffect, MachineView } from '../../ui/src/model/wire.ts';

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
    expect(b.waitingOn.map((j) => j.status)).toEqual(['waiting_on']);
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
  it('every count is the length of the list it names, for any mix of statuses; failed is the ledger\'s (issue #1067)', () => {
    const jobs = STATUSES.flatMap((status, i) => Array.from({ length: i + 1 }, (_, n) => job(`${status}-${n}`, { status })));
    const b = jobBoard(jobs, []);
    const items = { waiting_for_approval: 0, queued: 0, working: 0, needs_you: 0, waiting_outside: 0, pr_open: 0, partly_done: 0, done: 0, failed: 2, blocked: 0, dropped: 0 };
    const k = kpis(b, [machine([lane('lane-1', 'busy'), lane('lane-2', 'draining'), lane('lane-3', 'idle')], 4)], items);
    expect(k).toEqual({
      waiting: b.waiting.length, held: b.waiting.filter((j) => j.status === 'held').length,
      waitingAnswer: b.waitingAnswer.length, parked: b.parked.length, waitingOn: b.waitingOn.length,
      finished: b.ended.filter((j) => j.status === 'finished').length, failed: 2,
      lanesBusy: 2, lanesOpen: 3, lanesMax: 4, lanesOver: 0,
    });
    // No count of job statuses: failed jobs the ledger does not count are no failure; none read yet, none shown.
    expect(b.ended.some((j) => j.status === 'failed')).toBe(true);
    expect(kpis(b, [], { ...items, failed: 0 }).failed).toBe(0);
    expect(kpis(b, [], null).failed).toBe(0);
  });
  it('a job on its own command is no wait on the outside world; stuck, it waits (issue #1037); it is in flight, as the ledger counts it (issue #1164)', () => {
    const since = '2026-10-03T10:00:00Z';
    const own = { for: 'the test run', until: 'background command 1 ends', since, ownCommand: true as const };
    const b = jobBoard([
      job('own', { status: 'waiting_on', wait: own }),
      job('stuck', { status: 'waiting_on', wait: { ...own, stuckAt: since } }),
      job('out', { status: 'waiting_on', wait: { for: 'a review', since } }),
    ], []);
    const k = kpis(b, [], null);
    expect(k.waitingOn).toBe(2);
    expect(b.waitingOn.map(ownWaitOf)).toEqual(['command', 'stuck', undefined]);
  });
  it('one job on a question and nothing queued: waiting 0, waiting answer 1 (issue #45)', () => {
    const b = jobBoard([job('q', { status: 'waiting_answer' })], []);
    const k = kpis(b, [], null);
    expect([k.waiting, k.waitingAnswer]).toEqual([0, 1]);
    expect(waitingRows(b, undefined)).toEqual([]);
  });
});

describe('the Lanes card (issue #1181)', () => {
  const effect = (cap: number, over: Partial<MachineLaneEffect> = {}): MachineLaneEffect => ({ machineId: 'm1', label: 'laptop', online: true, maxLanes: 6, usedFrac: 0, cap, band: 'free', executors: [], ...over });
  const seven = [lane('lane-1', 'draining'), ...[3, 4, 5, 6, 7].map((n) => lane(`lane-${n}`, 'busy')), lane('lane-8', 'idle')];
  it('lanes holding a job, busy and draining, over the machine\'s effective cap; the amount over it said', () => {
    const k = kpis(jobBoard([], []), [machine(seven, 6)], null, [effect(6)]);
    expect([k.lanesBusy, k.lanesMax, k.lanesOver, k.lanesOpen]).toEqual([6, 6, 0, 7]);
    const over = kpis(jobBoard([], []), [machine([...seven.slice(0, 6), lane('lane-2', 'busy')], 6)], null, [effect(6)]);
    expect([over.lanesBusy, over.lanesMax, over.lanesOver]).toEqual([7, 6, 1]);
  });
  it('the effective cap is the decider\'s, usage pacing included; with no reading, or offline, the machine\'s lanes', () => {
    const lanes = [lane('lane-1', 'busy'), lane('lane-2', 'draining'), lane('lane-3', 'busy')];
    expect(kpis(jobBoard([], []), [machine(lanes, 6)], null, [effect(2, { band: 'soft' })])).toMatchObject({ lanesBusy: 3, lanesMax: 2, lanesOver: 1 });
    expect(kpis(jobBoard([], []), [machine(lanes, 6)], null, [effect(0, { band: 'offline', online: false })])).toMatchObject({ lanesMax: 6, lanesOver: 0 });
    expect(kpis(jobBoard([], []), [machine(lanes, 6)], null, null)).toMatchObject({ lanesMax: 6, lanesOver: 0 });
  });
  it('unopened is the cap less the open lanes; lanes past the cap are said, never clamped to 0', () => {
    expect(lanesSub(kpis(jobBoard([], []), [machine(seven, 6)], null, [effect(6)]))).toBe('7 open · 1 idle past the cap');
    expect(lanesSub(kpis(jobBoard([], []), [machine(seven.slice(0, 4), 6)], null, [effect(6)]))).toBe('4 open · 2 unopened');
    expect(lanesSub(kpis(jobBoard([], []), [machine([...seven.slice(0, 6), lane('lane-2', 'busy')], 6)], null, [effect(6)]))).toBe('7 open · 1 over the cap');
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
    const k = kpis(b, [machine([lane('lane-1', 'idle')])], null);
    expect([b.running.length, k.waiting, k.waitingAnswer, k.lanesBusy, k.parked]).toEqual([0, 0, 0, 0, 1]);
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
  it('a specialty job\'s lane past the machine\'s lanes is an elbow-in (issue #762); one inside them is not', () => {
    const s = job('s', { spec: { executor: 'test', payload: {}, specialty: true } });
    const over = laneRows([machine([lane('lane-1', 'busy', 'a'), lane('lane-2', 'busy', 's')], 1)], [job('a'), s]);
    expect(over.map((r) => [r.job?.id, r.elbowIn ?? false])).toEqual([['a', false], ['s', true]]);
    const inside = laneRows([machine([lane('lane-1', 'busy', 's')], 2)], [s]);
    expect(inside.map((r) => r.elbowIn ?? false)).toEqual([false, false]);
  });
  it('a tend job\'s lane past the machine\'s lanes is an elbow-in too (issue #967)', () => {
    const t = job('t', { spec: { executor: 'test', payload: {}, tend: true } });
    const over = laneRows([machine([lane('lane-1', 'busy', 'a'), lane('lane-2', 'busy', 't')], 1)], [job('a'), t]);
    expect(over.map((r) => [r.job?.id, r.elbowIn ?? false])).toEqual([['a', false], ['t', true]]);
  });
  it('a lane a reattach opened past the cap is marked while the machine is over its cap (issue #1181)', () => {
    const back = { ...lane('lane-2', 'busy', 'b'), pastCap: true as const };
    const over = laneRows([machine([lane('lane-1', 'busy', 'a'), back], 1)], [job('a'), job('b')]);
    expect(over.map((r) => [r.job?.id, r.pastCap ?? false])).toEqual([['a', false], ['b', true]]);
    expect(laneRows([machine([lane('lane-1', 'busy', 'a'), back], 2)], [job('a'), job('b')]).some((r) => r.pastCap)).toBe(false);
  });
});

describe('lane job (issue #432)', () => {
  it('a lane names its job by id whatever its status: a waiting job still on its lane shows there', () => {
    const w = job('w', { status: 'waiting_answer', laneId: 'm1/lane-1' });
    const rows = laneRows([machine([lane('lane-1', 'busy', 'w')], 1)], [], new Map([['w', w]]));
    expect(rows.map((r) => r.job?.id)).toEqual(['w']);
  });
  it('an ended or parked job a stale lane still names does not show on it', () => {
    const jobs = new Map([['f', job('f', { status: 'finished' })], ['p', job('p', { status: 'parked' })]]);
    const rows = laneRows([machine([lane('lane-1', 'busy', 'f'), lane('lane-2', 'busy', 'p')], 2)], [], jobs);
    expect(rows.map((r) => r.job)).toEqual([undefined, undefined]);
  });
  it('a claimed job is starting, a running one busy, any other still on a lane waiting', () => {
    expect(STATUSES.map((status) => [status, laneJobState(job(status, { status }))]).filter(([, s]) => s !== 'waiting')).toEqual([
      ['claimed', 'starting'], ['running', 'busy'],
    ]);
  });
});

describe('overCap (issue #762)', () => {
  it('a machine with more lanes in use than its lanes reads in use over its lanes; one back at its lanes drops out', () => {
    const lanes = [lane('lane-1', 'busy', 'a'), lane('lane-2', 'draining', 's'), lane('lane-3', 'busy', 'b')];
    expect(overCap([machine(lanes, 2)])).toEqual([{ machineId: 'm1', inUse: 3, lanes: 2 }]);
    expect(overCap([machine(lanes.slice(0, 2), 2)])).toEqual([]);
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
  it('a cancelled job can run again too (issue #1352)', () => {
    expect(canRerun(job('c', { status: 'cancelled', ...src('k'), ...reported() }), [])).toBe(true);
  });
  it('not once a newer job of its item exists, nor a live job, nor one of no source', () => {
    const failed = job('f', { status: 'failed', ...src('k'), ...reported() });
    expect(canRerun(failed, [failed, job('n', { status: 'queued', ...src('k'), createdAt: '2026-10-03T11:00:00Z' })])).toBe(false);
    expect(canRerun(job('r', { status: 'running', ...src('k'), ...reported() }), [])).toBe(false);
    expect(canRerun(job('s', { status: 'failed', ...reported() }), [])).toBe(false);
  });
  it('not while its end is not reported to its source yet: the daemon refuses that', () => {
    expect(canRerun(job('f', { status: 'failed', ...src('k') }), [])).toBe(false);
    expect(canRerun(job('f', { status: 'failed', ...src('k'), ...reported({ finalReported: false }) }), [])).toBe(false);
  });
});


describe('waitOnLink (issue #1245)', () => {
  const since = '2026-10-15T00:00:00Z';
  const waiting = (on?: NonNullable<Job['wait']>['on']) =>
    job('w', { status: 'waiting_on', source: { repo: 'o/r' } as Job['source'], wait: { for: 'x', since, ...(on ? { on } : {}) } });
  it('a pull request, an item or a job is a link; an outside event is words', () => {
    expect(waitOnLink(waiting({ kind: 'pull_request', number: 12, about: 'merge' }))).toEqual({ label: 'PR #12 to merge', href: 'https://github.com/o/r/pull/12' });
    expect(waitOnLink(waiting({ kind: 'item', repo: 'a/b', number: 3 }))).toEqual({ label: 'a/b#3', href: 'https://github.com/a/b/issues/3' });
    expect(waitOnLink(waiting({ kind: 'job', jobId: 'j9' }))).toEqual({ label: 'job j9', href: '#job/j9' });
    expect(waitOnLink(waiting({ kind: 'outside', what: 'a release' }))).toEqual({ label: 'outside (reason not given): a release' });
  });
  it('an outside event says why a person acts: not managed, or gated (issue #1510)', () => {
    expect(waitOnLink(waiting({ kind: 'outside', what: 'a fix upstream', why: 'not_managed' }))).toEqual({ label: 'outside (not managed): a fix upstream' });
    expect(waitOnLink(waiting({ kind: 'outside', what: 'the IaC apply', why: 'gated' }))).toEqual({ label: 'outside (gated): the IaC apply' });
  });
  it('a wait from before says nothing recorded; a job not on a wait has none', () => {
    expect(waitOnLink(waiting())).toEqual({ label: 'nothing recorded' });
    expect(waitOnLink(job('r'))).toBeUndefined();
  });
});

describe('waitOnLinkOf (issue #1245): the job graph\'s node and the job view say the same', () => {
  it('links what the wait is on in the repository it names, else the node\'s', () => {
    expect(waitOnLinkOf({ kind: 'pull_request', number: 12, about: 'checks' }, 'o/r')).toEqual({ label: 'PR #12 checks to end', href: 'https://github.com/o/r/pull/12' });
    expect(waitOnLinkOf({ kind: 'question', questionId: 'q1' }, undefined)).toEqual({ label: 'a person\'s answer to question q1', href: '#question-q1' });
    expect(waitOnLinkOf(undefined, 'o/r')).toEqual({ label: 'nothing recorded' });
  });
});

describe('a wait check, in words (issue #1694)', () => {
  const T = Date.parse('2026-10-17T10:00:00.000Z');
  const check = (o: object = {}) => ({ condition: { kind: 'none' as const }, nextCheckAt: new Date(T + 4 * 60_000).toISOString(), everyMs: 60000, attempts: 0, deadline: new Date(T + 3600_000).toISOString(), ...o });
  it('what it checks, when it checks next, and the last result', () => {
    expect(waitCheckText(check({ condition: { kind: 'job_ended', jobId: 'j9' } }), T)).toEqual({ what: 'the hopper checks whether job j9 ended', next: 'next check in 4 min' });
    expect(waitCheckText(check({ condition: { kind: 'question_settled', questionId: 'q1' }, result: 'question q1 is open' }), T)).toMatchObject({ what: 'the hopper checks whether question q1 is settled', last: 'question q1 is open' });
    expect(waitCheckText(check({ nextCheckAt: new Date(T - 1000).toISOString() }), T)).toEqual({ what: 'the hopper has no check for it: only its deadline counts', next: 'next check now' });
    expect(waitCheckText(check({ overdueAt: new Date(T).toISOString() }), T)).toMatchObject({ overdue: true });
  });

  it('a pull request\'s checks, a time the job named, and a time beside a condition (part 2)', () => {
    expect(waitCheckText(check({ condition: { kind: 'pr_checks_ended', repo: 'o/r', number: 8 } }), T).what).toBe('the hopper checks whether the checks of o/r#8 ended');
    expect(waitCheckText(check({ condition: { kind: 'pr_review_ended', repo: 'o/r', number: 8 } }), T).what).toBe('the hopper checks whether o/r#8 got a review');
    expect(waitCheckText(check({ condition: { kind: 'time_passed', at: '2026-10-17T12:00:00.000Z' } }), T).what).toBe('the hopper wakes it at 2026-10-17 12:00 UTC');
    expect(waitCheckText(check({ condition: { kind: 'job_ended', jobId: 'j9' }, wakeAt: '2026-10-17T12:00:00.000Z' }), T).what).toBe('the hopper checks whether job j9 ended, and wakes it at 2026-10-17 12:00 UTC');
  });

  it('a recheck of an outside event the hopper cannot see (issue #2335)', () => {
    expect(waitCheckText(check({ condition: { kind: 'recheck', at: '2026-10-17T12:00:00.000Z' } }), T).what).toBe('the hopper cannot see it: it wakes the job at 2026-10-17 12:00 UTC to look again');
  });
});
