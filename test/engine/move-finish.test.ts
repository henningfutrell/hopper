// Issue #1892 (milestone 3): a job the hopper parks to move it off a machine — the busy-machine move, the signed-out move
// — goes back to the queue, also when the hopper stops between the park and the pick up. The park marks the move on the
// job (`parked.move`), and the move's next pass, on this host or on the one that takes its lease after a restart, finishes
// it: the pane ended once more only when its end was not confirmed, the checkpoint taken again, then picked up elsewhere
// (or queued as a new start). Before, the job stayed parked for a person, and its item in Needs you. Against the real
// database, with a fake clock, machines, checkpoints and executor.
//
// Feature: a move cut short by a stop is finished
//   Scenario: a busy-machine move stopped after its park resumes elsewhere at the next pass, its pane ended once
//   Scenario: a busy-machine move stopped before its pane ended ends it at the next pass
//   Scenario: a signed-out move stopped after its park resumes elsewhere at the next pass, with no sign-out read
//   Scenario: a move of a job that never got its task is finished as a new start
//   Scenario: a job a person parked, or one picked up meanwhile, is left as it is
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry, UserStore } from '../../src/domain/ports.ts';
import type { Job, JobCheckpoint, MachineSnapshot } from '../../src/domain/types.ts';
import { createBusyMove, RESUME_WAIT_MS } from '../../src/engine/busy-move.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { createSignedOutMove } from '../../src/engine/signed-out-move.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const T0 = Date.parse('2026-10-21T22:00:00.000Z');
let now = T0;
const clock = { now: () => new Date(now) };
const opened: UserStore[] = [];
const FLEET: MachineSnapshot[] = ['l1', 'l2'].map((id) => ({ id, label: id, maxLanes: 2, online: true, executors: ['herdr-claude'] }));

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  now = T0;
});

/** One hopper on the store: `stopAt`, the call at which it stops (`park`: while its executor ends the pane). */
function hopper(store: UserStore, o: { stopAt?: 'park' | 'parked' } = {}) {
  const ended: string[] = [];
  const taken: string[] = [];
  let stopped = false;
  const executors = {
    get: () => ({
      park: async (j: Job) => {
        if (o.stopAt === 'park') { stopped = true; throw new Error('the hopper stops'); }
        ended.push(j.id);
        if (o.stopAt === 'parked') stopped = true;
      },
    }),
    names: () => ['herdr-claude'],
  } as unknown as ExecutorRegistry;
  const checkpoints = {
    take: async (id: string) => {
      taken.push(id);
      const k: JobCheckpoint = { at: clock.now().toISOString(), machineId: 'l2', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'], bytes: 10, session: true };
      store.jobs.update(id, { checkpoint: k });
      return k;
    },
  };
  const c = {
    store, clock, executors, checkpoints, machines: { list: async () => FLEET }, usage: () => [], stopping: () => stopped, trigger: () => undefined,
  } as unknown as EngineContext;
  return { busy: createBusyMove(c), signedOut: createSignedOutMove(c), ended, taken };
}

function db(): UserStore {
  const store = openUserStore({ url: testDatabaseUrl(), clock, idGen: randomUUID });
  opened.push(store);
  // l2's two lanes are in use.
  for (const n of [1, 2]) store.lanes.update(store.lanes.open('l2').id, { state: 'busy', jobId: `busy-${n}` });
  return store;
}

/** A job queued to resume on l2 with its answer pending in its live pane. */
function resuming(store: UserStore, o: { session?: boolean } = {}): Job {
  const job = store.jobs.create({ executor: 'herdr-claude', payload: {} }, 50);
  return store.jobs.update(job.id, { status: 'queued', pendingAnswer: 'Use the blue paint.', resumeOn: 'l2', ...(o.session === false ? {} : { agentSession: 'session-1' }) });
}

const typesOf = (store: UserStore, id: string) => store.events.recent(50, undefined, id).reverse().map((e) => e.type);

/** The busy-machine move of `job` on a hopper that stops at `stopAt`. */
async function busyStopped(store: UserStore, stopAt: 'park' | 'parked'): Promise<void> {
  const first = hopper(store, { stopAt });
  await first.busy();
  now += RESUME_WAIT_MS;
  await first.busy();
}

describe('a move cut short by a stop (issue #1892)', () => {
  it('a busy-machine move stopped after its park resumes elsewhere at the next pass, its pane ended once', async () => {
    const store = db();
    const job = resuming(store);
    await busyStopped(store, 'parked');
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'parked', parked: { move: { kind: 'busy_machine', how: 'checkpoint', live: true, ended: true } } });
    const parked = store.events.recent(50, ['job.parked'], job.id)[0]!;
    expect(parked.data).toMatchObject({ move: 'busy_machine' });

    // The restart: a new hopper on the same database. Its pass finishes the move.
    const next = hopper(store);
    await next.busy();
    const moved = store.jobs.get(job.id)!;
    expect(moved).toMatchObject({ status: 'queued', pendingAnswer: 'Use the blue paint.', agentSession: 'session-1' });
    expect(moved.parked?.elsewhere).toMatchObject({ from: 'l2' });
    expect(moved.parked?.move).toBeUndefined();
    // The pane ended before the stop: not again. Its checkpoint is taken once more, with its agent ended.
    expect(next.ended).toEqual([]);
    expect(next.taken).toEqual([job.id]);
    expect(typesOf(store, job.id).filter((t) => t === 'job.parked' || t === 'job.unparked')).toEqual(['job.parked', 'job.unparked']);
    // Once only.
    await next.busy();
    expect(typesOf(store, job.id).filter((t) => t === 'job.unparked')).toHaveLength(1);
  });

  it('a busy-machine move stopped before its pane ended ends it at the next pass', async () => {
    const store = db();
    const job = resuming(store);
    await busyStopped(store, 'park');
    expect(store.jobs.get(job.id)?.parked?.move).toMatchObject({ kind: 'busy_machine', live: true });
    expect(store.jobs.get(job.id)?.parked?.move?.ended).toBeUndefined();
    const next = hopper(store);
    await next.busy();
    expect(next.ended).toEqual([job.id]);
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'queued', parked: { elsewhere: { from: 'l2' } } });
  });

  it('a signed-out move stopped after its park resumes elsewhere at the next pass, with no sign-out read', async () => {
    const store = db();
    const job = store.jobs.create({ executor: 'herdr-claude', payload: {} }, 50);
    store.jobs.update(job.id, { status: 'parked', agentSession: 'session-1', resumeOn: 'l2', pendingAnswer: 'Claude is signed in on l1 now.', parked: { at: new Date(T0).toISOString(), from: 'waiting_answer', move: { kind: 'signed_out', how: 'checkpoint', live: true, ended: true } } });
    const next = hopper(store);
    await next.signedOut();
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'queued', pendingAnswer: 'Claude is signed in on l1 now.', parked: { elsewhere: { from: 'l2' } } });
    expect(typesOf(store, job.id)).toEqual(['job.unparked']);
    // The busy-machine move's pass leaves the signed-out move's job to it.
    const other = store.jobs.create({ executor: 'herdr-claude', payload: {} }, 50);
    store.jobs.update(other.id, { status: 'parked', agentSession: 'session-1', resumeOn: 'l2', parked: { at: new Date(T0).toISOString(), from: 'waiting_answer', move: { kind: 'signed_out', how: 'checkpoint', live: true, ended: true } } });
    await next.busy();
    expect(store.jobs.get(other.id)?.status).toBe('parked');
  });

  it('a move of a job that never got its task is finished as a new start', async () => {
    const store = db();
    const job = resuming(store, { session: false });
    await busyStopped(store, 'parked');
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'parked', parked: { move: { how: 'fresh' } } });
    await hopper(store).busy();
    const moved = store.jobs.get(job.id)!;
    expect(moved.status).toBe('queued');
    expect(moved.parked).toBeUndefined();
    expect(moved.resumeOn).toBeUndefined();
    expect(moved.pendingAnswer).toBeUndefined();
  });

  it('a job a person parked, or one picked up meanwhile, is left as it is', async () => {
    const store = db();
    const parked = store.jobs.create({ executor: 'herdr-claude', payload: {} }, 50);
    store.jobs.update(parked.id, { status: 'parked', agentSession: 'session-1', resumeOn: 'l2', parked: { at: new Date(T0).toISOString(), from: 'running', by: 'someone', via: 'ui' } });
    const picked = resuming(store);
    await busyStopped(store, 'parked');
    store.jobs.update(picked.id, { status: 'queued' });
    const next = hopper(store);
    await next.busy();
    expect(store.jobs.get(parked.id)?.status).toBe('parked');
    expect(typesOf(store, picked.id).filter((t) => t === 'job.unparked')).toEqual([]);
    expect(next.taken).toEqual([]);
  });
});
