// The crash harness on topology discovery (issue #1954, design.md "The crash harness"): a hopper killed with SIGKILL
// before or after each step of the `topology-discovery` saga — an account or a cluster read and reported, and the step
// not recorded among them — leaves the run a person asked for to a second hopper on the same database, which ends it done
// with the account and its cluster in the graph once each.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { killedThenDiscovered, SCENARIO_MS, TOPOLOGY_KILL_POINTS, topologyWorld, type TopologyWorld } from './topology-world.ts';

const worlds: TopologyWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('topology discovery killed at each step boundary (issue #1954)', () => {
  for (const point of TOPOLOGY_KILL_POINTS) {
    it(`killed at ${point}: the next hopper ends the run, the account and its cluster read once each`, async () => {
      const w = await topologyWorld();
      worlds.push(w);
      await killedThenDiscovered(w, point);
    }, SCENARIO_MS);
  }
});
