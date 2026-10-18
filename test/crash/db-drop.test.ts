// A database connection dropped while a step's record commits (issue #1954, design.md "The crash harness"): the first
// hopper reaches Postgres through a proxy that ends the connection at the statement that records a step done — before
// Postgres reads it, or after it committed and before its answer came back. The record is then either all there or not
// there at all; the hopper is killed, and a second one ends the mint with each effect made once.
import { afterEach, describe, expect, it } from 'vitest';
import { stallingProxy, type StallingProxy } from '../support/stalling-proxy.ts';
import { stopHosts } from './harness.ts';
import { goOn, mintedOnce, mintSteps, SCENARIO_MS, turnOn, world, type World } from './mint-world.ts';

const worlds: World[] = [];
const proxies: StallingProxy[] = [];
afterEach(async () => {
  await stopHosts();
  for (const p of proxies.splice(0)) await p.close();
  for (const w of worlds.splice(0)) await w.close();
});

/** The statement that writes a saga (src/store/sagas.ts `save`): its try started, then its record, for each step. */
const SAVE = 'UPDATE sagas SET state';
const STEPS = ['zone', 'tunnel', 'ingress', 'token', 'dns', 'record'];

describe('the mint saga with its database connection dropped at a step\'s record (issue #1954)', () => {
  for (const step of ['tunnel', 'record']) {
    for (const after of [false, true]) {
      it(`cloudflare: dropped ${after ? 'after' : 'before'} the record of ${step} commits, the step is all recorded or not at all`, async () => {
        const w = await world();
        worlds.push(w);
        const proxy = await stallingProxy(w.url);
        proxies.push(proxy);
        const a = await w.host({ databaseUrl: proxy.url });
        const { dropped } = await proxy.drop({ at: SAVE, nth: 2 * (STEPS.indexOf(step) + 1), after });
        const answer = turnOn(a, 'cloudflare');
        await dropped;
        expect((await answer).status).not.toBe(200);
        await a.kill();
        expect(mintSteps(w.url).find((s) => s.name === step)?.state).toBe(after ? 'done' : 'pending');
        await goOn(w, (v) => v.enabled && v.provisioned?.provider === 'cloudflare');
        mintedOnce(w, 'cloudflare');
      }, SCENARIO_MS);
    }
  }
});
