// Stuck work (issue #1010): every item that waits on a person — an open hand-off, a failure, work not pushed, a pull
// request the hopper gave up on, a parked job, a job stuck on its own wait — in exactly one stuck cause, counted, with
// one bulk action when the hopper takes it for each of them, else what a person does. Pure.
import { describe, expect, it } from 'vitest';
import type { Allowed, FailureRecordView, HandoffResolutionAction, HandoffView, Job, KeptWorkView, PullRequestCard } from '../../src/domain/types.ts';
import { stuckOf } from '../../src/domain/stuck.ts';

const OK: Allowed = { ok: true };
const no = (why: string, soon?: true): Allowed => ({ ok: false, why, ...(soon ? { soon } : {}) });

function handoff(id: string, recommended: HandoffResolutionAction, over: Partial<HandoffView['actions']> = {}, recordId?: string): HandoffView {
  return {
    id, jobId: `job-${id}`, status: 'open', reason: 'person', openedAt: '2026-10-13T00:00:00.000Z', ...(recordId ? { recordId } : {}),
    card: { whatHappened: 'The job stopped.', recommended, why: `why ${id}` }, continueResumes: true,
    actions: { continue: OK, fixed: OK, doneByHand: OK, wontDo: OK, ...over },
  } as unknown as HandoffView;
}
const record = (id: string, retry: Allowed, handoffId?: string): FailureRecordView =>
  ({ id, jobId: `job-${id}`, actions: { retry }, ...(handoffId ? { handoffId } : {}) }) as unknown as FailureRecordView;
const kept = (jobId: string, push: Allowed, handoffId?: string): KeptWorkView =>
  ({ jobId, paths: ['/w/x'], at: '2026-10-13T00:00:00.000Z', status: 'failed', actions: { push, discard: OK }, ...(handoffId ? { handoffId } : {}) }) as KeptWorkView;
const card = (jobId: string, over: Partial<PullRequestCard>): PullRequestCard => ({ jobId, repo: 'o/r', state: 'open', ...over }) as PullRequestCard;
const job = (id: string, over: Partial<Job>): Job => ({ id, status: 'parked', ...over }) as Job;

const empty = { handoffs: [], recent: [], keptWork: [], pullRequests: [], jobs: [], prOpen: [], leftovers: [] };

describe('stuck work by cause (issue #1010)', () => {
  it('nothing stuck: no cause', () => {
    expect(stuckOf(empty)).toEqual([]);
  });

  it('open hand-offs by the card\'s recommended resolution; a bulk action for each one the hopper takes', () => {
    const causes = stuckOf({
      ...empty,
      handoffs: [
        handoff('a', 'continue'), handoff('b', 'continue'), handoff('c', 'fixed'), handoff('d', 'wont_do'),
        handoff('e', 'done_by_hand'), handoff('f', 'fixed', { fixed: no('it runs again by itself', true) }),
        { ...handoff('g', 'continue'), status: 'closed' } as HandoffView,
      ],
    });
    expect(causes.map((c) => [c.cause, c.ids, c.act !== undefined])).toEqual([
      ['continue', ['a', 'b'], true],
      ['run_again', ['c'], true],
      ['wont_do', ['d'], true],
      ['done_by_hand', ['e'], false],
      ['taken_soon', ['f'], false],
    ]);
    // A cause with no bulk action says what a person does.
    expect(causes.find((c) => c.cause === 'done_by_hand')!.todo).toMatch(/Done/);
  });

  it('a failure runs again in bulk only when it takes Retry and no open hand-off counts it already', () => {
    const causes = stuckOf({
      ...empty,
      handoffs: [handoff('h', 'continue', {}, 'r3')],
      recent: [record('r1', OK), record('r2', no('its item is closed')), record('r3', OK, 'h')],
    });
    expect(causes.find((c) => c.cause === 'retry')!.ids).toEqual(['r1']);
    expect(causes.flatMap((c) => c.ids).sort()).toEqual(['h', 'r1']);
  });

  it('work not pushed: Push it in bulk when taken, and its hand-off is counted there, not twice', () => {
    const causes = stuckOf({
      ...empty,
      handoffs: [handoff('h', 'continue')],
      keptWork: [kept('job-h', OK, 'h'), kept('k2', no('its agent session cannot resume'))],
    });
    expect(causes.map((c) => [c.cause, c.ids])).toEqual([['push', ['job-h']], ['kept_work', ['k2']]]);
    // Never a push on its machine (issue #2087): the machine holds no GitHub credentials.
    expect(causes.find((c) => c.cause === 'kept_work')?.todo).toBe('Press Discard in Work not pushed, or run its item again. Do not push on its machine: it holds no GitHub credentials.');
  });

  it('pull requests the hopper gave up on: Tend again in bulk for a failed tend; failing checks and a refused tend say what to do', () => {
    const causes = stuckOf({
      ...empty,
      pullRequests: [
        card('p1', { waits: 'tend failed', gaveUp: 'the job that rebased it was cancelled' }),
        card('p2', { waits: 'checks failing', gaveUp: 'checks still fail after 3 fixes' }),
        card('p3', { waits: 'conflicts', queue: { refused: 'its source refused' } }),
        card('p4', { waits: 'conflicts', queue: { next: true } }),
      ],
    });
    expect(causes.map((c) => [c.cause, c.ids, c.act !== undefined])).toEqual([
      ['tend', ['p1'], true], ['checks', ['p2'], false], ['tend_refused', ['p3'], false],
    ]);
  });

  it('jobs stuck on their own wait: counted, with what a person does; a parked job is not stuck work (issue #2414)', () => {
    const causes = stuckOf({
      ...empty,
      jobs: [job('j1', {}), job('j2', { status: 'waiting_on', wait: { for: 'x', since: 's', ownCommand: true, stuckAt: 't' } }), job('j3', { status: 'waiting_on', wait: { for: 'x', since: 's', on: { kind: 'grant' } } })],
    });
    expect(causes.map((c) => [c.cause, c.ids])).toEqual([['own_wait', ['j2']]]);
    expect(causes.every((c) => c.act === undefined && c.todo)).toBe(true);
    expect(stuckOf({ ...empty, jobs: [job('j1', {})] })).toEqual([]);
  });

  it('a legacy job waiting on nothing recorded (issue #1245): stuck work with that reason, and Resume all', () => {
    const causes = stuckOf({
      ...empty,
      jobs: [job('j1', { status: 'waiting_on', wait: { for: 'x', since: 's' } }), job('j2', { status: 'waiting_on' }), job('j3', { status: 'waiting_on', wait: { for: 'x', since: 's', on: { kind: 'outside', what: 'x' } } })],
    });
    expect(causes).toEqual([{ cause: 'wait_unnamed', ids: ['j1', 'j2'], what: 'Jobs waiting on nothing recorded', act: 'Resume all' }]);
  });

  it('a job on a wait whose agent session ended (issue #1779): stranded, with Wake all, before its own wait\'s cause', () => {
    const causes = stuckOf({
      ...empty,
      jobs: [
        job('j1', { status: 'waiting_on', wait: { for: 'x', since: 's', on: { kind: 'grant' }, strandedAt: 't' } }),
        job('j2', { status: 'waiting_on', wait: { for: 'x', since: 's', on: { kind: 'grant' }, strandedAt: 't', check: { overdueAt: 't' } as never } }),
        job('j3', { status: 'waiting_on', wait: { for: 'x', since: 's', on: { kind: 'grant' } } }),
      ],
    });
    expect(causes).toEqual([{ cause: 'stranded', ids: ['j1', 'j2'], what: 'Jobs on a wait whose agent session ended', act: 'Wake all' }]);
  });

  it('items left in PR open with no pull request to wait on (issue #1231): counted by their job, with what a person does', () => {
    const causes = stuckOf({ ...empty, prOpen: ['j1', 'j2'] });
    expect(causes.map((c) => [c.cause, c.ids])).toEqual([['pr_open_stale', ['j1', 'j2']]]);
    expect(causes[0]!.act).toBeUndefined();
    expect(causes[0]!.todo).toMatch(/Run again/);
  });

  it('jobs that wait for memory while no job runs (issue #2303): counted, with what a person does; not while a job runs', () => {
    const starved = job('q1', { status: 'queued', waitReason: 'waiting for memory: local has 2 GiB available, and a new job needs 2 GiB over its floor of 1.4 GiB' });
    const lane = job('q2', { status: 'queued', waitReason: 'waiting for a lane' });
    const causes = stuckOf({ ...empty, jobs: [starved, lane] });
    expect(causes.map((c) => [c.cause, c.ids])).toEqual([['memory_starved', ['q1']]]);
    expect(causes[0]!.act).toBeUndefined();
    expect(causes[0]!.todo).toMatch(/memory/);
    expect(stuckOf({ ...empty, jobs: [starved, job('r1', { status: 'running' })] })).toEqual([]);
  });

  it('the bulk causes come first', () => {
    const causes = stuckOf({ ...empty, jobs: [job('j1', { status: 'waiting_on', wait: { for: 'x', since: 's', ownCommand: true, stuckAt: 't' } })], recent: [record('r1', OK)] });
    expect(causes.map((c) => c.cause)).toEqual(['retry', 'own_wait']);
  });

  it('lists ended jobs whose cleanup left something, with what a person does (issue #2504)', () => {
    const causes = stuckOf({ ...empty, leftovers: ['j1', 'j2'] });
    expect(causes.map((c) => [c.cause, c.ids])).toEqual([['cleanup_leftover', ['j1', 'j2']]]);
    expect(causes[0]).toMatchObject({ what: 'Ended jobs whose cleanup left something on a machine' });
    expect(causes[0]?.act).toBeUndefined();
  });
});
