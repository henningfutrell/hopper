// Issue #2622 part 3: the heavy-step gate one user's jobs ask before a heavy step (`POST /job/heavy`). It keeps the steps
// it let run, each on a lease the job's client renews; a step whose job stopped renewing it is let go.
import { describe, expect, it } from 'vitest';
import { HEAVY_LEASE_MS, createHeavyGate } from '../../src/engine/heavy-gate.ts';
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
    expect(gate.renew(at(1), (kept as { slot: string }).slot)).toBe(true);
    pass(2000);
    expect(gate.held().map((s) => s.jobId)).toEqual(['j1']);
    expect(gate.renew(at(2), 'slot-2')).toBe(false);
  });

  it('a job renews or releases only its own slot', async () => {
    const { gate, at } = rig();
    const a = await gate.take(at(1), ['npm', 'install']);
    expect(gate.renew(at(2), (a as { slot: string }).slot)).toBe(false);
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
