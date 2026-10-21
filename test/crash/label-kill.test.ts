// The label mirror under the crash harness (issue #1892 part 11, design.md "The item lifecycle"): a hopper killed with
// SIGKILL while its mirror corrects an item's labels, or once it recorded a label a person took off by hand, leaves the item
// to a second hopper on the same database. It ends it with each effect once: the labels changed on GitHub once; one Run
// again, one new job, and the label not put back.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { CORRECTION_KILL_POINTS, editedThenKilled, killedThenMirrored, labelWorld, SCENARIO_MS, type LabelWorld } from './label-world.ts';

const worlds: LabelWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the label mirror killed at each kill point of its correction (issue #1892)', () => {
  for (const point of CORRECTION_KILL_POINTS) {
    it(`killed at ${point}: the next hopper changes the labels once`, async () => {
      const w = await labelWorld();
      worlds.push(w);
      await killedThenMirrored(w, point);
    }, SCENARIO_MS);
  }
});

describe('a label taken off by hand, the hopper killed once it recorded the edit (issue #1892)', () => {
  it('the next hopper runs the item again once and does not put the label back', async () => {
    const w = await labelWorld();
    worlds.push(w);
    await editedThenKilled(w);
  }, SCENARIO_MS);
});
