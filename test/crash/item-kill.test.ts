// The item lifecycle under the crash harness (issue #1954, design.md "The crash harness"; issue #1891, "The item
// lifecycle"): a hopper killed with SIGKILL inside a block's transaction — its event written, its label rows not —, once a
// correction's event is kept, and before, inside and after a run again's call leaves the items to a second hopper on the
// same database. It ends them with each effect once: the item blocked once with its labels changed on GitHub once, a
// person asked once, and one new job of the item whose pull request was closed.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { ITEM_KILL_POINTS, itemWorld, killedThenCorrected, SCENARIO_MS, type ItemWorld } from './item-world.ts';

const worlds: ItemWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the item reconciler killed at each kill point of its corrections (issue #1954)', () => {
  for (const point of ITEM_KILL_POINTS) {
    it(`killed at ${point}: the next hopper ends what is left, each effect once`, async () => {
      const w = await itemWorld();
      worlds.push(w);
      await killedThenCorrected(w, point);
    }, SCENARIO_MS);
  }
});
