// The crash harness on a Windows step (issue #1954, design.md "The crash harness"): a hopper killed with SIGKILL at each
// step boundary of the `windows-step` saga, while the step runs on the host, or while it compensates a step the job
// stopped, leaves the step to a second hopper on the same database. That hopper ends the saga: the step ran on the host
// once, the host's scratch is swept and its host lease let go, and the job reads one result.
import { afterEach, describe, expect, it } from 'vitest';
import { STEP_INTERRUPTED } from '../../src/windows-steps/index.ts';
import { stopHosts } from './harness.ts';
import { killedThenEnded, SCENARIO_MS, WINDOWS_COMPENSATION_KILL_POINTS, WINDOWS_STEP_KILL_POINTS, windowsWorld, type WindowsWorld } from './windows-world.ts';

const worlds: WindowsWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const world = async (): Promise<WindowsWorld> => {
  const w = await windowsWorld();
  worlds.push(w);
  return w;
};

describe('a Windows step killed at each step boundary of its saga (issue #1954)', () => {
  for (const point of WINDOWS_STEP_KILL_POINTS) {
    it(`killed at ${point}: the next hopper ends the step, run once, with its result; the host swept and let go`, async () => {
      expect(await killedThenEnded(await world(), { point })).toEqual({ exit: 0, problem: undefined, saga: 'done' });
    }, SCENARIO_MS);
  }

  it('killed while the step runs on the host: the next hopper does not run it again, says why, and sweeps the host', async () => {
    expect(await killedThenEnded(await world(), {})).toEqual({ exit: 125, problem: STEP_INTERRUPTED, saga: 'done' });
  }, SCENARIO_MS);

  for (const point of WINDOWS_COMPENSATION_KILL_POINTS) {
    it(`the job stops its step, killed at ${point}: the next hopper ends it cancelled; the host swept and let go`, async () => {
      expect(await killedThenEnded(await world(), { point, stop: true })).toEqual({ exit: 125, problem: expect.stringContaining('cancelled'), saga: 'compensated' });
    }, SCENARIO_MS);
  }
});
