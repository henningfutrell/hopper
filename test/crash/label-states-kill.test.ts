// The label mirror killed while it corrects items in more states (issue #1892 part 25, design.md "The item lifecycle"):
// dropped by a person's Close PR, and dropped by a person's Won't do. The next hopper changes each label once.
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
    it(`killed at ${point}: the next hopper changes the labels of a Close PR and a Won't do item once`, async () => {
      const w = await statesWorld();
      worlds.push(w);
      await statesKilledThenMirrored(w, point);
    }, SCENARIO_MS);
  }
});
