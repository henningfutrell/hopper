// The crash harness on the remote access mint saga (issue #1954, design.md "The crash harness"): a hopper killed with
// SIGKILL before or after each step's do — a provider call made and not recorded among them — leaves the mint to a
// second hopper on the same database, which ends it with each effect made once at the provider and remote access on.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { doPoints, killedThenGoneOn, SCENARIO_MS, world, type World } from './mint-world.ts';

const worlds: World[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the mint saga killed at each step boundary (issue #1954)', () => {
  for (const provider of ['cloudflare', 'ngrok'] as const) {
    for (const point of doPoints(provider)) {
      it(`${provider}: killed at ${point}, the next hopper mints each once`, async () => {
        const w = await world();
        worlds.push(w);
        await killedThenGoneOn(w, provider, point, false);
      }, SCENARIO_MS);
    }
  }
});
