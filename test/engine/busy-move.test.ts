// Issue #1977, the busy-machine move: a job queued to resume on its own machine, where every lane is in use, waits there a
// short time only (`RESUME_WAIT_MS`). Then, when another machine that runs its executor has room, it resumes elsewhere from
// its checkpoint, as Parked's Resume elsewhere does; or, when its agent never got its task, it is queued as a new start,
// not pinned. A job whose checkpoint cannot be taken, or holds work but no agent session, stays. Against the real database,
// with a fake clock, machines, checkpoints and executor.
//
// Feature: the busy-machine move
//   Scenario: a job picked up on a full machine resumes elsewhere from its checkpoint after the wait, not before
//   Scenario: a job with an answer pending in its live pane is parked first: its pane ends, then it resumes elsewhere
//   Scenario: a job whose agent never got its task is queued as a new start, not pinned
//   Scenario: a job whose checkpoint holds no agent session stays on its machine
//   Scenario: the wait starts again when its machine has room before it ends
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry, UserStore } from '../../src/domain/ports.ts';
import type { Job, JobCheckpoint, MachineSnapshot } from '../../src/domain/types.ts';
import { createBusyMove, RESUME_WAIT_MS } from '../../src/engine/busy-move.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const T0 = Date.parse('2026-10-18T22:00:00.000Z');
let now = T0;
const clock = { now: () => new Date(now) };
const opened: UserStore[] = [];
const FLEET: MachineSnapshot[] = ['l1', 'l2', 'l3'].map((id) => ({ id, label: id, maxLanes: 2, online: true, executors: ['herdr-claude'] }));

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  now = T0;
});

function hopper(o: { session?: boolean } = {}) {
  const store = openUserStore({ url: testDatabaseUrl(), clock, idGen: randomUUID });
  opened.push(store);
  const parked: string[] = [];
  const taken: string[] = [];
  const executors = { get: () => ({ park: async (j: Job) => { parked.push(j.id); } }), names: () => ['herdr-claude'] } as unknown as ExecutorRegistry;
  const checkpoints = {
    take: async (id: string) => {
      taken.push(id);
      const k: JobCheckpoint = { at: clock.now().toISOString(), machineId: 'l2', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'], bytes: 10, session: o.session ?? true };
      store.jobs.update(id, { checkpoint: k });
      return k;
    },
  };
  const triggers: string[] = [];
  const c = { store, clock, executors, checkpoints, machines: { list: async () => FLEET }, stopping: () => false, trigger: (r: string) => triggers.push(r) } as unknown as EngineContext;
  // l2's two lanes are in use.
  for (const n of [1, 2]) store.lanes.update(store.lanes.open('l2').id, { state: 'busy', jobId: `busy-${n}` });
  return { store, move: createBusyMove(c), parked, taken, triggers };
}

/** A job queued to resume on l2: picked up after a park (its pane ended), or answered in its live pane (`live`). */
function resuming(store: UserStore, o: { live?: boolean; session?: boolean } = {}): Job {
  const job = store.jobs.create({ executor: 'herdr-claude', payload: {} }, 50);
  return store.jobs.update(job.id, {
    status: 'queued', pendingAnswer: 'Use the blue paint.', resumeOn: 'l2',
    ...(o.session === false ? {} : { agentSession: 'session-1' }),
    ...(o.live ? {} : { parked: { at: new Date(T0).toISOString(), from: 'running' } }),
  });
}

const eventsOf = (store: UserStore, id: string) => store.events.recent(50, undefined, id).reverse().map((e) => ({ type: e.type, data: e.data }));

describe('the busy-machine move (issue #1977)', () => {
  it('a job picked up on a full machine resumes elsewhere from its checkpoint after the wait, not before', async () => {
    const { store, move, parked, taken, triggers } = hopper();
    const job = resuming(store);
    await move();
    now += RESUME_WAIT_MS - 1;
    await move();
    expect(store.jobs.get(job.id)!.resumeOn).toBe('l2');
    now += 1;
    await move();
    const moved = store.jobs.get(job.id)!;
    expect(moved).toMatchObject({ status: 'queued', pendingAnswer: 'Use the blue paint.', agentSession: 'session-1' });
    expect(moved.resumeOn).toBeUndefined();
    expect(moved.parked?.elsewhere).toMatchObject({ from: 'l2' });
    // Its pane ended at its park: nothing to end now, and its checkpoint is not taken again.
    expect(parked).toEqual([]);
    expect(taken).toEqual([job.id]);
    const why = 'every lane of l2 was in use for 5 min, and l1, l3 have room: it resumes elsewhere';
    expect(eventsOf(store, job.id).slice(-2)).toEqual([
      { type: 'job.parked', data: { from: 'running', machineId: 'l2', auto: true, why, move: 'busy_machine' } },
      { type: 'job.unparked', data: { to: 'queued', elsewhere: true } },
    ]);
    expect(triggers).toContain('busy_machine.move');
  });

  it('a job with an answer pending in its live pane is parked first: its pane ends, then it resumes elsewhere', async () => {
    const { store, move, parked, taken } = hopper();
    const job = resuming(store, { live: true });
    await move();
    now += RESUME_WAIT_MS;
    await move();
    expect(parked).toEqual([job.id]);
    // Once to know it can move, once more with its agent ended, so its session is whole.
    expect(taken).toEqual([job.id, job.id]);
    const moved = store.jobs.get(job.id)!;
    expect(moved).toMatchObject({ status: 'queued', pendingAnswer: 'Use the blue paint.' });
    expect(moved.parked).toMatchObject({ from: 'waiting_answer', elsewhere: { from: 'l2' } });
  });

  it('a job whose agent never got its task is queued as a new start, not pinned', async () => {
    const { store, move } = hopper();
    const job = resuming(store, { session: false });
    await move();
    now += RESUME_WAIT_MS;
    await move();
    const moved = store.jobs.get(job.id)!;
    expect(moved.status).toBe('queued');
    expect(moved.resumeOn).toBeUndefined();
    expect(moved.parked).toBeUndefined();
    expect(moved.pendingAnswer).toBeUndefined();
  });

  it('a job whose checkpoint holds no agent session stays on its machine', async () => {
    const { store, move } = hopper({ session: false });
    const job = resuming(store);
    await move();
    now += RESUME_WAIT_MS;
    await move();
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'queued', resumeOn: 'l2' });
  });

  it('the wait starts again when its machine has room before it ends', async () => {
    const { store, move } = hopper();
    const job = resuming(store);
    await move();
    now += RESUME_WAIT_MS - 1000;
    const lane = store.lanes.list('l2')[0]!;
    store.lanes.update(lane.id, { state: 'idle', jobId: undefined });
    await move();
    store.lanes.update(lane.id, { state: 'busy', jobId: 'busy-3' });
    now += 1000;
    await move();
    expect(store.jobs.get(job.id)!.resumeOn).toBe('l2');
    now += RESUME_WAIT_MS;
    await move();
    expect(store.jobs.get(job.id)!.resumeOn).toBeUndefined();
  });
});
