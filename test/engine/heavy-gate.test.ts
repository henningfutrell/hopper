// Issue #2622 part 3: the heavy-step gate one user's jobs ask before a heavy step (`POST /job/heavy`). It keeps the steps
// it let run, each on a lease the job's client renews; a step whose job stopped renewing it is let go.
import { describe, expect, it } from 'vitest';
import { HEAVY_LEASE_MS, HEAVY_RENEW_S, HEAVY_WAIT_SEEN_MS, createHeavyGate } from '../../src/engine/heavy-gate.ts';
import { HEAVY_RETRY_S } from '../../src/domain/heavy-steps.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { NOW, job, machine } from '../decider/support.ts';

const GIB = 1024 ** 3;

function rig(machines: MachineSnapshot[] = [machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB } })]) {
  let now = Date.parse(NOW);
  let n = 0;
  const gate = createHeavyGate({
    clock: { now: () => new Date(now) }, idGen: () => `slot-${++n}`, machines: async () => machines,
    machineOf: (j: Job) => j.laneId?.split('/')[0],
  });
  const at = (i: number): Job => job(`j${i}`, { status: 'running', laneId: `local/lane-${i}` });
  return { gate, at, pass: (ms: number) => { now += ms; } };
}

describe('the heavy-step gate (issue #2622 part 3)', () => {
  it('4 lanes ask for a JVM build at once: 2 take a slot, 2 wait with the reason', async () => {
    const { gate, at } = rig();
    const answers = await Promise.all([1, 2, 3, 4].map((i) => gate.take(at(i), ['./gradlew', 'test'])));
    expect(answers.filter((a) => 'slot' in a)).toHaveLength(2);
    const waits = answers.filter((a) => 'wait' in a);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatchObject({ retryS: 5 });
    expect((waits[0] as { wait: string }).wait).toContain('local runs 2 JVM builds, and holds at most 2 at once');
    expect(gate.held().map((s) => s.jobId)).toEqual(['j1', 'j2']);
  });

  it('a released slot lets the next step run', async () => {
    const { gate, at } = rig();
    const first = await gate.take(at(1), ['./gradlew', 'test']);
    await gate.take(at(2), ['./gradlew', 'test']);
    expect(await gate.take(at(3), ['./gradlew', 'test'])).toHaveProperty('wait');
    expect(gate.release(at(1), (first as { slot: string }).slot)).toBe(true);
    expect(await gate.take(at(3), ['./gradlew', 'test'])).toHaveProperty('slot');
  });

  it('a slot whose job stops renewing it is let go after its lease; a renewed one is kept', async () => {
    const { gate, at, pass } = rig();
    const kept = await gate.take(at(1), ['./gradlew', 'test']);
    await gate.take(at(2), ['./gradlew', 'test']);
    pass(HEAVY_LEASE_MS - 1000);
    expect(await gate.renew(at(1), (kept as { slot: string }).slot)).toEqual({ ok: true });
    pass(2000);
    expect(gate.held().map((s) => s.jobId)).toEqual(['j1']);
    expect(await gate.renew(at(2), 'slot-2')).toEqual({ ok: false });
  });

  it('a job renews or releases only its own slot', async () => {
    const { gate, at } = rig();
    const a = await gate.take(at(1), ['npm', 'install']);
    expect(await gate.renew(at(2), (a as { slot: string }).slot)).toEqual({ ok: false });
    expect(gate.release(at(2), (a as { slot: string }).slot)).toBe(false);
    expect(gate.held()).toHaveLength(1);
  });

  it('a command that is not heavy, or a machine with no memory reading, runs at once with no slot', async () => {
    const { gate, at } = rig();
    expect(await gate.take(at(1), ['npm', 'run', 'lint'])).toEqual({ light: 'npm run lint is no heavy step' });
    const bare = rig([machine({ maxLanes: 8 })]);
    expect(await bare.gate.take(bare.at(1), ['./gradlew', 'test'])).toEqual({ light: 'local has no memory reading the gate counts' });
    expect(bare.gate.held()).toEqual([]);
  });
});

describe('the heavy-step gate reserves what history says (issue #2622 part 4)', () => {
  function withPeaks(peaks: (j: Job) => Promise<number[]>, available = 10) {
    const machines = [machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: available * GIB } })];
    let n = 0;
    const gate = createHeavyGate({ clock: { now: () => new Date(NOW) }, idGen: () => `slot-${++n}`, machines: async () => machines, machineOf: () => 'local', peaks });
    const at = (i: number, repo = 'o/app'): Job => job(`j${i}`, { status: 'running', laneId: `local/lane-${i}`, source: { source: 'github', kind: 'issue', key: `k${i}`, repo } });
    return { gate, at };
  }

  it('a repository whose jobs peaked at 3 GiB reserves about 3 GiB for its step, the most of its recent peaks', async () => {
    const { gate, at } = withPeaks(async (j) => (j.source?.repo === 'o/app' ? [2.5 * GIB, 3 * GIB, 1 * GIB] : []));
    await gate.take(at(1), ['npm', 'install']);
    await gate.take(at(2, 'o/new'), ['npm', 'install']);
    expect(gate.held().map((s) => [s.jobId, s.bytes, s.recorded])).toEqual([['j1', 3 * GIB, true], ['j2', 1 * GIB, false]]);
  });

  it('the reserve from history decides the wait, and the wait says it is the recorded peak', async () => {
    // 7 GiB available, floor 1.4 GiB, 1 GiB kept for the first install: one that needs 6 GiB does not fit, one of 1 GiB does.
    const { gate, at } = withPeaks(async (j) => (j.source?.repo === 'o/big' ? [6 * GIB] : []), 7);
    expect(await gate.take(at(1), ['npm', 'install'])).toHaveProperty('slot');
    const a = await gate.take(at(2, 'o/big'), ['npm', 'install']);
    expect(a).toHaveProperty('wait');
    expect((a as { wait: string }).wait).toContain('this step needs 6 GiB (its repository\'s recorded peak)');
    expect(await gate.take(at(3), ['npm', 'install'])).toHaveProperty('slot');
  });

  it('a history that cannot be read reserves the estimate', async () => {
    const { gate, at } = withPeaks(async () => { throw new Error('postgres: down'); });
    expect(await gate.take(at(1), ['./gradlew', 'test'])).toHaveProperty('slot');
    expect(gate.held()[0]).toMatchObject({ bytes: 3 * GIB, recorded: false });
  });
});

// Issue #2622 part 5: synthetic memory pressure stops new heavy steps, and pauses the newest one that runs within 30 s: its
// client learns it at its next renew, every HEAVY_RENEW_S. When the pressure clears, it runs again.
describe('the heavy-step gate sheds on memory pressure (issue #2622 part 5)', () => {
  const reading = (available: number, someAvg60 = 0) => ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: available * GIB, memPressure: { someAvg10: someAvg60, fullAvg10: 0, someAvg60 } });

  it('pressure stops new steps and pauses the newest within 30 s; when it clears, the step runs again and new ones start', async () => {
    const m = machine({ maxLanes: 8, resources: reading(10) });
    const { gate, at, pass } = rig([m]);
    const first = (await gate.take(at(1), ['./gradlew', 'test'])) as { slot: string };
    pass(1000);
    const newest = (await gate.take(at(2), ['npm', 'install'])) as { slot: string };
    expect(HEAVY_RENEW_S * 1000).toBeLessThanOrEqual(30_000 / 2);
    m.resources = reading(6, 25);
    pass(HEAVY_RENEW_S * 1000);
    expect(await gate.take(at(3), ['npm', 'install'])).toEqual({
      wait: 'local is under memory pressure: its tasks waited on memory 25% of the last 60 s, over 10%; a heavy step starts when it clears', retryS: 5,
    });
    expect(await gate.renew(at(1), first.slot)).toEqual({ ok: true });
    expect(await gate.renew(at(2), newest.slot)).toEqual({
      ok: true, pause: 'local is under memory pressure: its tasks waited on memory 25% of the last 60 s, over 10%: the newest heavy step is paused until it clears',
    });
    expect(gate.held().map((s) => [s.jobId, s.paused !== undefined])).toEqual([['j1', false], ['j2', true]]);
    m.resources = reading(10);
    pass(30_000);
    expect(await gate.take(at(3), ['npm', 'install'])).toMatchObject({ wait: 'local has a heavy step paused for memory pressure; a heavy step starts when it runs again' });
    expect(await gate.renew(at(2), newest.slot)).toEqual({ ok: true });
    expect(gate.held().map((s) => s.paused)).toEqual([undefined, undefined]);
    expect(await gate.take(at(3), ['npm', 'install'])).toHaveProperty('slot');
  });
});

// Issue #2622 part 7: the Machines page shows each machine's heavy steps: those that run, those paused and why, and those
// that wait and why. A wait is kept while its job asks again; a job that stopped asking is no longer listed.
describe('the heavy-step gate\'s view (issue #2622 part 7)', () => {
  it('lists the steps that run and those that wait, with the reason and since when', async () => {
    const { gate, at, pass } = rig();
    await gate.take(at(1), ['./gradlew', 'test']);
    await gate.take(at(2), ['./gradlew', 'test']);
    await gate.take(at(3), ['./gradlew', 'build']);
    pass(HEAVY_RETRY_S * 1000);
    await gate.take(at(3), ['./gradlew', 'build']);
    expect(gate.view().map((s) => [s.jobId, s.machineId, s.kind, s.command, s.waiting === true])).toEqual([
      ['j1', 'local', 'build', './gradlew test', false], ['j2', 'local', 'build', './gradlew test', false], ['j3', 'local', 'build', './gradlew build', true],
    ]);
    const wait = gate.view().find((s) => s.waiting)!;
    expect(wait.since).toBe(NOW);
    expect(wait.reason).toContain('local runs 2 JVM builds, and holds at most 2 at once');
  });

  it('a wait ends when its step takes a slot, or when its job stops asking', async () => {
    const { gate, at, pass } = rig();
    const first = (await gate.take(at(1), ['./gradlew', 'test'])) as { slot: string };
    await gate.take(at(2), ['./gradlew', 'test']);
    await gate.take(at(3), ['./gradlew', 'test']);
    gate.release(at(1), first.slot);
    await gate.take(at(3), ['./gradlew', 'test']);
    expect(gate.view().filter((s) => s.waiting)).toEqual([]);
    await gate.take(at(4), ['./gradlew', 'test']);
    expect(gate.view().filter((s) => s.waiting).map((s) => s.jobId)).toEqual(['j4']);
    pass(HEAVY_WAIT_SEEN_MS + 1);
    expect(gate.view().filter((s) => s.waiting)).toEqual([]);
  });

  it('a paused step says why', async () => {
    const m = machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB } });
    const { gate, at, pass } = rig([m]);
    await gate.take(at(1), ['./gradlew', 'test']);
    pass(1000);
    const newest = (await gate.take(at(2), ['npm', 'install'])) as { slot: string };
    m.resources = { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 1 * GIB };
    await gate.renew(at(2), newest.slot);
    const paused = gate.view().find((s) => s.jobId === 'j2')!;
    expect(paused.paused).toBeDefined();
    expect(paused.reason).toContain('the newest heavy step is paused until it clears');
  });
});
