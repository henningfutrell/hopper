// The label mirror killed while it corrects items in more states (issue #1892 parts 25, 26, design.md "The item lifecycle"):
// dropped by a person's Close PR, dropped by a person's Won't do, blocked with no pull request, and a hand-off. The next hopper changes each label once.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { CORRECTION_KILL_POINTS, SCENARIO_MS } from './label-world.ts';
import { statesKilledThenMirrored, statesWorld, type StatesWorld } from './label-states-world.ts';

const worlds: StatesWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the label mirror killed at each kill point of its correction, in more states (issue #1892)', () => {
  for (const point of CORRECTION_KILL_POINTS) {
    it(`killed at ${point}: the next hopper changes the labels of each item once`, async () => {
      const w = await statesWorld();
      worlds.push(w);
      await statesKilledThenMirrored(w, point);
    }, SCENARIO_MS);
  }
});
