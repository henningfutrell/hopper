// The crash harness on the GitHub proxy (issue #1959 part 2, design.md "The GitHub proxy under crashes"): a hopper killed
// with SIGKILL before or after the GitHub call of each write a job asks for — a call GitHub took and the hopper never
// recorded among them — and the job's request sent again, with the same resend key, to a second hopper on the same
// database. GitHub then holds each effect once: an issue or a comment GitHub made before the kill is found by its post key
// and not made again, a required child is linked once, and the job's timeline records each write done once.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { killedThenSentAgain, killPointsOf, PROXY_WRITES, proxyWorld, SCENARIO_MS, type ProxyWorld } from './proxy-world.ts';

const worlds: ProxyWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the GitHub proxy killed at each call of each write a job asks for (issue #1959)', () => {
  for (const write of PROXY_WRITES) {
    for (const point of killPointsOf(write)) {
      it(`${write.name}, killed at ${point}: sent again to the next hopper, GitHub holds it once`, async () => {
        const w = await proxyWorld();
        worlds.push(w);
        await killedThenSentAgain(w, write, point);
      }, SCENARIO_MS);
    }
  }
});
