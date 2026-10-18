// A Windows step as a saga (issue #1611, design.md "Windows sandbox steps"): a step kept in the real database and run by
// the real coordinator. A hopper stopped mid-step leaves the step to the next start, which goes on from there: the step
// runs on its host once at the most, the job reads one result, and the host's scratch directory is removed. One step
// runs on a host at a time, across hosts too; a step asked while another runs waits, and runs after a stop. The Windows
// host is a double at its seam (`WindowsStepHost`), which keeps a scratch directory per host until it is swept.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import type { WindowsHost, WindowsStepHost } from '../../src/domain/windows-steps.ts';
import { createSagaCoordinator, type SagaCoordinator } from '../../src/sagas/coordinator.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createWindowsSteps, STEP_INTERRUPTED, WINDOWS_STEP_SAGA, windowsStepSaga, type WindowsSteps } from '../../src/windows-steps/index.ts';
import { endLeases } from '../crash/harness.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();
const LEASE_MS = 60_000;
const quiet = { info: () => {}, warn: () => {} };
const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: 'ssh-ed25519 AAAA', workDir: 'C:\\work\\app' };
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;

/** The Windows host: the scratch directory each host keeps until it is swept, the runs of each step, and how many run at once. */
function world() {
  const scratch = new Set<string>(), runs = new Map<string, number>();
  let running = 0, most = 0, away = false;
  let block: (() => void) | undefined;
  const host: WindowsStepHost = {
    async run(h, step, io) {
      running++; most = Math.max(most, running);
      scratch.add(h.name);
      runs.set(step.id, (runs.get(step.id) ?? 0) + 1);
      io.log(`ran ${step.command}\n`);
      const started = block;
      block = undefined;
      if (started) {
        // A step that runs until it is stopped: the stop leaves its scratch, as a hopper that stops does.
        started();
        await new Promise((r) => { io.signal.addEventListener('abort', r, { once: true }); });
        running--;
        return { exit: 255, problem: 'stopped before it ended' };
      }
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { exit: 0 };
    },
    async sweep(h) {
      if (away) throw new Error(`${h.name} cannot be reached`);
      scratch.delete(h.name);
    },
  };
  return {
    host, scratch, runs, most: () => most,
    setAway: (v: boolean) => { away = v; },
    /** The next step runs until it is stopped. Resolves when it started. */
    block: (): Promise<void> => new Promise((r) => { block = r; }),
  };
}

describe('a Windows step as a saga (issue #1611)', () => {
  const stores: InstanceStore[] = [], coordinators: SagaCoordinator[] = [], dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((c) => c.stop()));
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  let ids = 0, keys = 0;

  /** One hopper: its store, its Windows steps and its coordinator, on the shared database and the shared host. */
  const hopper = (url: string, owner: string, w: ReturnType<typeof world>, clock: ReturnType<typeof fixedClock>) => {
    const store = openInstanceStore({ url, clock });
    stores.push(store);
    const dir = mkdtempSync(join(tmpdir(), 'win-saga-'));
    dirs.push(dir);
    const held: { c?: SagaCoordinator } = {};
    const steps: WindowsSteps = createWindowsSteps({
      userId: 'admin', hosts: () => [HOST], host: w.host, steps: store.windowsSteps, atWork: () => true, dir, record: () => {}, log: () => {}, now: () => clock.now(),
      sagas: { begin: (step) => held.c!.begin(WINDOWS_STEP_SAGA, step, { step }, { userId: 'admin' }).id, abort: (saga, reason) => held.c!.abort(saga, reason) },
    });
    const c = held.c = createSagaCoordinator({ repo: store.sagas, definitions: [windowsStepSaga({ steps: () => steps })], owner, clock, idGen: () => `saga-${++ids}`, logger: quiet, leaseMs: LEASE_MS, renewMs: 1e9 });
    coordinators.push(c);
    return { store, steps, c };
  };
  const later = (clock: ReturnType<typeof fixedClock>, ms: number): void => clock.set(new Date(clock.now().getTime() + ms).toISOString());
  const start = (steps: WindowsSteps, command = 'msbuild App.sln'): string => {
    const r = steps.start(JOB, { host: HOST.name, command, outputs: [] }, { key: `key-${String(++keys).padStart(4, '0')}`, inputs: Buffer.alloc(0) });
    if ('no' in r) throw new Error(r.no);
    return r.id;
  };
  const sagaOf = (h: ReturnType<typeof hopper>, id: string): string => h.store.windowsSteps.get(id)!.saga!;

  it('with no stop, the step runs once; the job reads its result and log from any host; the host\'s scratch is removed', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock), b = hopper(url, 'host-b', w, clock);
    const id = start(a.steps);
    expect((await a.c.drive(sagaOf(a, id)))?.state).toBe('done');
    expect(w.runs.get(id)).toBe(1);
    expect(b.steps.state(JOB, id)).toEqual({ result: { exit: 0 } });
    expect(b.steps.log(JOB, id, 0)).toEqual({ text: 'ran msbuild App.sln\n', next: 20, ended: true });
    expect(w.scratch.size).toBe(0);
  });

  it('a hopper stopped mid-step: the next start ends the step once, with why, removes the host\'s scratch, and runs the step that waited', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    const blocked = w.block();
    const first = start(a.steps);
    await blocked;
    // A second step asked meanwhile waits for the host, and says so.
    const second = start(a.steps, 'dotnet test');
    await expect.poll(() => a.steps.log(JOB, second, 0)?.text).toBe('hopper-step: waiting for build-host: another step runs there\n');
    expect(a.steps.state(JOB, second)).toEqual({ running: true });

    await a.c.stop();
    expect(a.steps.state(JOB, first)).toEqual({ running: true });
    expect(w.scratch.has(HOST.name)).toBe(true);

    const b = hopper(url, 'host-b', w, clock);
    // A lease ends on the database's clock (issue #1954).
    endLeases(url);
    await b.c.pass();
    expect(b.store.sagas.get(sagaOf(b, first))?.state).toBe('done');
    // It may have had its effect: it is not run again, and the job's poll gets one result that says so.
    expect(w.runs.get(first)).toBe(1);
    expect(b.steps.state(JOB, first)).toEqual({ result: { exit: 125, problem: STEP_INTERRUPTED } });
    // The step that waited runs after it, once; the host's scratch is removed, and no step has a lease on the host.
    await expect.poll(() => b.steps.state(JOB, second), { timeout: 10_000 }).toEqual({ result: { exit: 0 } });
    await b.c.drive(sagaOf(b, second));
    expect(w.runs.get(second)).toBe(1);
    expect(w.scratch.size).toBe(0);
    expect([b.store.windowsSteps.get(first)?.hostLeased, b.store.windowsSteps.get(second)?.hostLeased]).toEqual([undefined, undefined]);
    expect(w.most()).toBe(1);
  });

  it('runs one step on a host at a time, also when two hoppers each run one', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock), b = hopper(url, 'host-b', w, clock);
    const one = start(a.steps), two = start(b.steps);
    await Promise.all([a.c.drive(sagaOf(a, one)), b.c.drive(sagaOf(b, two))]);
    await expect.poll(() => [a.steps.state(JOB, one), a.steps.state(JOB, two)], { timeout: 10_000 }).toEqual([{ result: { exit: 0 } }, { result: { exit: 0 } }]);
    expect(w.most()).toBe(1);
  });

  it('keeps the host while its scratch cannot be swept, and lets it go once the sweep goes through', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    w.setAway(true);
    const id = start(a.steps);
    expect((await a.c.drive(sagaOf(a, id)))?.state).toBe('running');
    expect(a.steps.state(JOB, id)).toEqual({ result: { exit: 0 } });
    expect(a.store.windowsSteps.get(id)?.hostLeased).toBe(true);
    w.setAway(false);
    later(clock, 1_001);
    expect((await a.c.drive(sagaOf(a, id)))?.state).toBe('done');
    expect(w.scratch.size).toBe(0);
    expect(a.store.windowsSteps.get(id)?.hostLeased).toBeUndefined();
  });

  it('the job stops its step: the step is stopped, the host swept and let go, and the step ends cancelled', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    const blocked = w.block();
    const id = start(a.steps);
    await blocked;
    expect(a.steps.stop(JOB, id)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect((await a.c.drive(sagaOf(a, id)))?.state).toBe('compensated');
    expect(a.steps.state(JOB, id)).toMatchObject({ result: { exit: 125, problem: expect.stringContaining('cancelled: aborted: job job-1 stopped the step') } });
    expect(w.scratch.size).toBe(0);
    expect(a.store.windowsSteps.get(id)?.hostLeased).toBeUndefined();
    expect(a.steps.stop(JOB, id)).toBe(false);
  });
});
