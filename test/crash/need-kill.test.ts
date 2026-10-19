// The crash harness on a need step (issue #1954, design.md "The crash harness"): a hopper killed with SIGKILL at each
// step boundary of the `need-step` saga, while the need box runs, or while it compensates a step the job stopped, leaves
// the step to a second hopper on the same database. That hopper ends the saga: the need box was made once at the most,
// no box or home is left at the runtime, every minted token's Secret is deleted, and the job reads one result.
import { afterEach, describe, expect, it } from 'vitest';
import { STEP_INTERRUPTED } from '../../src/sandbox/need-steps.ts';
import { stopHosts } from './harness.ts';
import { killedThenEnded, secondHostWhileBoxRuns, NEED_COMPENSATION_KILL_POINTS, NEED_STEP_KILL_POINTS, needWorld, SCENARIO_MS, type NeedWorld } from './need-world.ts';

const worlds: NeedWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const world = async (): Promise<NeedWorld> => {
  const w = await needWorld();
  worlds.push(w);
  return w;
};

describe('a need step killed at each step boundary of its saga (issue #1954)', () => {
  for (const point of NEED_STEP_KILL_POINTS) {
    it(`killed at ${point}: the next hopper ends the step, its box made once, with its result; nothing left`, async () => {
      expect(await killedThenEnded(await world(), { point })).toEqual({ exit: 0, problem: undefined, saga: 'done' });
    }, SCENARIO_MS);
  }

  it('killed while the need box runs: the next hopper does not run it again, says why, and burns the box', async () => {
    expect(await killedThenEnded(await world(), {})).toEqual({ exit: 125, problem: STEP_INTERRUPTED, saga: 'done' });
  }, SCENARIO_MS);

  for (const point of NEED_COMPENSATION_KILL_POINTS) {
    it(`the job stops its step, killed at ${point}: the next hopper ends it cancelled; nothing left`, async () => {
      expect(await killedThenEnded(await world(), { point, stop: true })).toEqual({ exit: 125, problem: expect.stringContaining('cancelled'), saga: 'compensated' });
    }, SCENARIO_MS);
  }
});

describe('two hoppers on one database while a need box runs (issues #1662, #1954)', () => {
  it('a second hopper that starts leaves the token of the first hopper\'s running box bound; it ends with the step', async () => {
    expect(await secondHostWhileBoxRuns(await world())).toEqual({ deletedWhileRunning: 0, boundAtEnd: 0 });
  }, SCENARIO_MS);
});
