// Sagas (issue #1524, design.md "Sagas: work that survives a stop"): sandbox work kept step by step in the database.
// A hopper stopped at any step leaves the saga to another host, which goes on from the last committed step with no
// effect done twice; an abort, before or after a stop, leaves no sandbox, credential or worktree behind.
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/ports.ts';
import { createSagaCoordinator, type SagaCoordinator, type SagaDefinition, type SagaStepContext } from '../../src/sagas/coordinator.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();
const LEASE_MS = 60_000;
const quiet = { info: () => {}, warn: () => {} };

/** The world outside the hopper: what each step made there, each keyed by the step's idempotency key. */
function world() {
  const sandboxes = new Set<string>(), credentials = new Set<string>(), worktrees = new Set<string>();
  const runs = new Set<string>(), pushes = new Set<string>(), pullRequests = new Set<string>();
  /** The effects each step had: a receiver that dedupes by key has each once. */
  const effects = new Map<string, number>();
  /** The do calls each step got, effect or not. */
  const calls = new Map<string, number>();
  let stopAt: { step: string; after: boolean; reached(): void } | undefined;
  let failing: string | undefined;
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
  /** Adds `key` to `set` once; a second try with the same key changes nothing. */
  const effect = (step: string, set: Set<string>, key: string): void => {
    if (set.has(key)) return;
    set.add(key);
    bump(effects, step);
  };
  /** A hopper that stops: the step never ends, so nothing after it is recorded. */
  const halt = (step: string, after: boolean): Promise<never> | undefined => {
    if (stopAt?.step !== step || stopAt.after !== after) return undefined;
    const s = stopAt;
    stopAt = undefined;
    s.reached();
    return new Promise<never>(() => {});
  };
  const step = (name: string, set: Set<string>, undo?: boolean) => ({
    name,
    async do(c: SagaStepContext) {
      bump(calls, name);
      if (failing === name) throw new Error(`${name} is refused`);
      const before = halt(name, false);
      if (before) return before;
      effect(name, set, c.key);
      const after = halt(name, true);
      if (after) return after;
      return { [name]: c.key };
    },
    ...(undo ? { async compensate(c: SagaStepContext) { set.delete(c.key); } } : {}),
  });
  const definition: SagaDefinition = {
    kind: 'sandbox-work',
    steps: [
      step('create sandbox', sandboxes, true),
      step('grant credential', credentials, true),
      step('set up worktree', worktrees, true),
      {
        name: 'run executor',
        async do(c) {
          bump(calls, 'run executor');
          const before = halt('run executor', false);
          if (before) return before;
          if (failing === 'run executor') throw new Error('run executor is refused');
          // The executor runs until it ends, or until the saga is aborted.
          if (blockRun) { blockRun = false; await new Promise<void>((_, reject) => { c.signal.addEventListener('abort', () => reject(c.signal.reason as Error)); runStarted?.(); }); }
          effect('run executor', runs, c.key);
          const after = halt('run executor', true);
          if (after) return after;
          return { session: `session-of-${c.saga.key}` };
        },
      },
      step('push', pushes),
      step('open pull request', pullRequests),
    ],
  };
  let blockRun = false, runStarted: (() => void) | undefined;
  return {
    sandboxes, credentials, worktrees, pushes, pullRequests, effects, calls, definition,
    /** The next try of `step` stops the hopper, before or after its effect. Resolves when it is reached. */
    stopAt: (s: string, after: boolean): Promise<void> => new Promise((reached) => { stopAt = { step: s, after, reached }; }),
    fail: (s: string | undefined) => { failing = s; },
    /** The executor's next run lasts until aborted. Resolves when it started. */
    blockRun: (): Promise<void> => { blockRun = true; return new Promise((r) => { runStarted = r; }); },
  };
}

const STEPS = ['create sandbox', 'grant credential', 'set up worktree', 'run executor', 'push', 'open pull request'];

describe('sagas', () => {
  const opened: InstanceStore[] = [];
  const coordinators: SagaCoordinator[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((c) => c.stop()));
    for (const s of opened.splice(0)) s.close();
  });
  let ids = 0;
  const hopper = (url: string, owner: string, w: ReturnType<typeof world>, clock: ReturnType<typeof fixedClock>) => {
    const store = openInstanceStore({ url, clock });
    opened.push(store);
    // A stopped hopper renews nothing: its lease ends LEASE_MS after its last write.
    const c = createSagaCoordinator({ repo: store.sagas, definitions: [w.definition], owner, clock, idGen: () => `saga-${++ids}`, logger: quiet, leaseMs: LEASE_MS, renewMs: 1e9 });
    coordinators.push(c);
    return { store, c };
  };
  const later = (clock: ReturnType<typeof fixedClock>, ms: number): void => clock.set(new Date(clock.now().getTime() + ms).toISOString());

  it('runs every step once, keeps what each made, and a second begin with the same key answers the first', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const { c, store } = hopper(url, 'host-a', w, clock);
    const s = c.begin('sandbox-work', 'job-1', { job: 'job-1' }, { userId: 'admin' });
    expect(c.begin('sandbox-work', 'job-1', { job: 'job-1' }).id).toBe(s.id);
    const done = await c.drive(s.id);
    expect(done?.state).toBe('done');
    expect(done?.data).toMatchObject({ job: 'job-1', session: 'session-of-job-1', 'create sandbox': `${s.id}/create sandbox` });
    for (const step of STEPS) expect(w.effects.get(step)).toBe(1);
    expect(store.sagas.open()).toEqual([]);
  });

  it('begin drives the saga only after its caller\'s synchronous work: a step reads what the caller did right after begin', async () => {
    const url = temp.url(), clock = fixedClock();
    const store = openInstanceStore({ url, clock });
    opened.push(store);
    let moved = false;
    const seen: boolean[] = [];
    const c = createSagaCoordinator({
      repo: store.sagas, owner: 'host-a', clock, idGen: () => `saga-${++ids}`, logger: quiet, leaseMs: LEASE_MS, renewMs: 1e9,
      definitions: [{ kind: 'move', steps: [{ name: 'end left', async do() { seen.push(moved); } }] }],
    });
    coordinators.push(c);
    const s = c.begin('move', 'job-1', {});
    moved = true;
    await c.drive(s.id);
    expect(seen).toEqual([true]);
  });

  for (const [i, step] of STEPS.entries()) {
    for (const after of [false, true]) {
      it(`a hopper stopped ${after ? 'after the effect of' : 'before'} step "${step}": another host goes on from there, no effect twice`, async () => {
        const url = temp.url(), w = world(), clock = fixedClock();
        const a = hopper(url, 'host-a', w, clock);
        const stopped = w.stopAt(step, after);
        const s = a.c.begin('sandbox-work', 'job-1', { job: 'job-1' });
        await stopped;

        // While its lease holds, no other host takes the saga.
        const b = hopper(url, 'host-b', w, clock);
        await b.c.pass();
        expect(b.store.sagas.get(s.id)?.state).toBe('running');
        expect(w.calls.get(step)).toBe(1);

        later(clock, LEASE_MS + 1);
        await b.c.pass();
        const end = b.store.sagas.get(s.id);
        expect(end?.state).toBe('done');
        for (const t of STEPS) expect(w.effects.get(t), t).toBe(1);
        // A step committed before the stop is never done again; the step that was cut short is done again.
        for (const t of STEPS.slice(0, i)) expect(w.calls.get(t), t).toBe(1);
        expect(w.calls.get(step)).toBe(2);
        expect(end?.data.session).toBe('session-of-job-1');
      });
    }
  }

  it('an abort mid-saga compensates each step done, newest first: no sandbox, credential or worktree is left', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const { c } = hopper(url, 'host-a', w, clock);
    const started = w.blockRun();
    const s = c.begin('sandbox-work', 'job-1', {});
    await started;
    expect([w.sandboxes.size, w.credentials.size, w.worktrees.size]).toEqual([1, 1, 1]);
    expect(c.abort(s.id, 'a person cancelled the job')).toBe(true);
    const end = await c.drive(s.id);
    expect(end?.state).toBe('compensated');
    expect(end?.error).toBe('aborted: a person cancelled the job');
    expect([w.sandboxes.size, w.credentials.size, w.worktrees.size, w.pushes.size, w.pullRequests.size]).toEqual([0, 0, 0, 0, 0]);
    expect(c.abort(s.id, 'again')).toBe(false);
  });

  it('an abort of a saga a stopped hopper left is compensated by another host once the lease ends', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    const stopped = w.stopAt('set up worktree', true);
    const s = a.c.begin('sandbox-work', 'job-1', {});
    await stopped;
    const b = hopper(url, 'host-b', w, clock);
    expect(b.c.abort(s.id, 'the job was cancelled')).toBe(true);
    later(clock, LEASE_MS + 1);
    await b.c.pass();
    expect(b.store.sagas.get(s.id)?.state).toBe('compensated');
    // The worktree its do made before the stop is removed too, though its do was never recorded done.
    expect([w.sandboxes.size, w.credentials.size, w.worktrees.size]).toEqual([0, 0, 0]);
    expect(w.calls.get('run executor')).toBeUndefined();
  });

  it('a step that keeps failing is tried again after a backoff, then the saga compensates', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const { c, store } = hopper(url, 'host-a', w, clock);
    w.fail('run executor');
    const s = c.begin('sandbox-work', 'job-1', {});
    let state = await c.drive(s.id);
    expect(state?.state).toBe('running');
    // Not before the backoff ends.
    await c.pass();
    expect(w.calls.get('run executor')).toBe(1);
    for (let n = 0; n < 10 && state?.state === 'running'; n++) {
      later(clock, 10 * 60_000);
      await c.pass();
      state = store.sagas.get(s.id);
    }
    expect(state?.state).toBe('compensated');
    expect(w.calls.get('run executor')).toBe(5);
    expect(state?.error).toBe('step run executor failed: run executor is refused');
    expect([w.sandboxes.size, w.credentials.size, w.worktrees.size]).toEqual([0, 0, 0]);
  });

  it('a stop releases the saga at once: another host goes on with no wait for the lease', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    const started = w.blockRun();
    const s = a.c.begin('sandbox-work', 'job-1', {});
    await started;
    await a.c.stop();
    const b = hopper(url, 'host-b', w, clock);
    await b.c.pass();
    expect(b.store.sagas.get(s.id)?.state).toBe('done');
    for (const t of STEPS) expect(w.effects.get(t), t).toBe(1);
  });
});
