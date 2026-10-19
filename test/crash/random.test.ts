// The randomised mode of the crash harness (issue #1954, design.md "The crash harness"): each seed picks a provider and
// a kill point of its mint saga — a compensation's when the provider refuses the mint — and runs the scenario. The same
// seed picks the same, so a failure names the seed and the kill point to run again: HOPPER_CRASH_SEED=<seed>. How many
// seeds: HOPPER_CRASH_SEEDS (default 2); the first is HOPPER_CRASH_SEED, else one from the clock, printed.
import { afterEach, describe, it } from 'vitest';
import { seeded, stopHosts } from './harness.ts';
import { compensatePoints, doPoints, killedThenGoneOn, SCENARIO_MS, world, type World } from './mint-world.ts';

const worlds: World[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const count = Number(process.env.HOPPER_CRASH_SEEDS || 2);
const first = Number(process.env.HOPPER_CRASH_SEED || Date.now() % 1_000_000);

describe('the crash harness, randomised (issue #1954)', () => {
  for (let seed = first; seed < first + count; seed++) {
    const pick = seeded(seed);
    const provider = pick(['cloudflare', 'ngrok'] as const);
    const fail = pick([false, true]);
    const point = pick(fail ? compensatePoints(provider) : doPoints(provider));
    it(`seed ${seed}: ${provider}, killed at ${point}`, async () => {
      const w = await world({ fail });
      worlds.push(w);
      try {
        await killedThenGoneOn(w, provider, point, fail);
      } catch (e) {
        throw new Error(`crash harness: seed ${seed}, kill point ${point} (${provider}${fail ? ', the provider refuses' : ''}): ${(e as Error).message}`, { cause: e });
      }
    }, SCENARIO_MS);
  }
});
