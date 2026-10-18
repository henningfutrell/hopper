// Two hoppers on one database whose clocks do not agree (issue #1954, design.md "The crash harness"): the first holds
// the mint saga while a step runs (the provider takes the call and does not answer), and the second's clock is ahead
// of the first's by more than a lease lasts. The second never takes the saga while the first renews its lease, so it
// never runs the step too; once the first is killed and its lease ends, the second ends the mint with each effect once.
import { afterEach, describe, expect, it } from 'vitest';
import { LEASE_MS, PASS_MS } from '../../src/sagas/coordinator.ts';
import { openDb } from '../../src/store/db.ts';
import { stopHosts } from './harness.ts';
import { goOn, mintedOnce, SCENARIO_MS, turnOn, world, type World } from './mint-world.ts';

const worlds: World[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

/** Who holds the one saga's lease now. */
function leaseOwner(url: string): unknown {
  const db = openDb(url);
  try { return db.get('SELECT lease_owner FROM sagas')?.lease_owner; } finally { db.close(); }
}

const SKEW_MS = 2 * LEASE_MS;

describe('two hoppers race one saga lease under a skewed clock (issue #1954)', () => {
  for (const c of [{ what: 'the second hopper\'s clock is ahead', first: 0, second: SKEW_MS }, { what: 'the first hopper\'s clock is behind', first: -SKEW_MS, second: 0 }]) {
    it(`${c.what}: the second never runs the step the first runs`, async () => {
      const w = await world();
      worlds.push(w);
      const a = await w.host({ clockSkewMs: c.first });
      const hung = w.cf.hang(1);
      void turnOn(a, 'cloudflare');
      await hung;
      const calls = w.cf.calls.length, owner = leaseOwner(w.url);
      expect(owner).toBeTruthy();
      const b = await w.host({ clockSkewMs: c.second });
      // The second's first pass runs at its start, the next PASS_MS on: two passes and a margin.
      await new Promise((r) => setTimeout(r, PASS_MS + 3_000));
      expect(w.cf.calls.slice(calls).map((x) => x.line), 'the second hopper ran the step the first runs').toEqual([]);
      expect(leaseOwner(w.url)).toBe(owner);
      await a.kill();
      await b.kill();
      await goOn(w, (v) => v.enabled && v.provisioned?.provider === 'cloudflare');
      mintedOnce(w, 'cloudflare');
    }, SCENARIO_MS);
  }
});
