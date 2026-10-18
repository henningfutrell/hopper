// A kill during compensation (issue #1954, design.md "The crash harness"): the provider refuses the mint's last call, so
// the saga undoes its first step; the hopper is killed with SIGKILL before or after that compensation, and a second
// hopper on the same database ends it with nothing left at the provider and remote access off.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { compensatePoints, killedThenGoneOn, SCENARIO_MS, world, type World } from './mint-world.ts';

const worlds: World[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the mint saga killed while it compensates (issue #1954)', () => {
  for (const provider of ['cloudflare', 'ngrok'] as const) {
    for (const point of compensatePoints(provider)) {
      it(`${provider}: killed at ${point}, the next hopper leaves nothing behind`, async () => {
        const w = await world({ fail: true });
        worlds.push(w);
        await killedThenGoneOn(w, provider, point, true);
      }, SCENARIO_MS);
    }
  }
});
