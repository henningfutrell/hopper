// The randomised mode of the crash harness on GitHub's writes (issue #1959 part 3, design.md "The crash harness"): each
// seed picks a family — the GitHub outbox's intake acts, a job's write through the GitHub proxy, a job's push (issue
// #1954), a person's act on a job, the landing batches' runner (issue #1954 part 8), or the item reconciler's corrections
// (part 9) — and one of its writes and kill
// points, and runs that scenario. The same seed picks the same, so a failure names
// the seed and the kill point to run again: HOPPER_CRASH_SEED=<seed>. How many seeds: HOPPER_CRASH_SEEDS (default 2);
// the first is HOPPER_CRASH_SEED, else one from the clock.
import { afterEach, describe, it } from 'vitest';
import { seeded, stopHosts } from './harness.ts';
import { actWorld, JOB_ACTS, killedThenActed, killPointsOf as actKillPoints } from './act-world.ts';
import { killedThenSent, OUTBOX_KILL_POINTS, outboxWorld } from './outbox-world.ts';
import { killedThenSentAgain, killPointsOf as proxyKillPoints, PROXY_WRITES, proxyWorld } from './proxy-world.ts';
import { killedThenSettled, PUSH_KILL_POINTS, pushWorld } from './push-world.ts';
import { killedThenEnded, LANDING_SCENARIOS, landingWorld } from './landing-world.ts';
import { ITEM_KILL_POINTS, itemWorld, killedThenCorrected } from './item-world.ts';

const SCENARIO_MS = 120_000;
const worlds: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const count = Number(process.env.HOPPER_CRASH_SEEDS ?? 2);
const first = Number(process.env.HOPPER_CRASH_SEED ?? Date.now() % 1_000_000);

/** What one seed runs: its name, and the scenario. */
function scenarioOf(seed: number): { name: string; run(): Promise<void> } {
  const pick = seeded(seed);
  const family = pick(['outbox', 'proxy', 'push', 'act', 'landing', 'item'] as const);
  if (family === 'outbox') {
    const point = pick(OUTBOX_KILL_POINTS);
    return { name: `the outbox, killed at ${point}`, run: async () => { const w = await outboxWorld(); worlds.push(w); await killedThenSent(w, point); } };
  }
  if (family === 'proxy') {
    const write = pick(PROXY_WRITES);
    const point = pick(proxyKillPoints(write));
    return { name: `${write.name} through the proxy, killed at ${point}`, run: async () => { const w = await proxyWorld(); worlds.push(w); await killedThenSentAgain(w, write, point); } };
  }
  if (family === 'push') {
    const point = pick(PUSH_KILL_POINTS);
    return { name: `a job's push, killed at ${point}`, run: async () => { const w = await pushWorld(); worlds.push(w); await killedThenSettled(w, point); } };
  }
  if (family === 'landing') {
    const scenario = pick(LANDING_SCENARIOS);
    const point = pick(scenario.points);
    return { name: `landing batches, ${scenario.name}, killed at ${point}`, run: async () => { const w = await landingWorld(scenario); worlds.push(w); await killedThenEnded(w, scenario, point); } };
  }
  if (family === 'item') {
    const point = pick(ITEM_KILL_POINTS);
    return { name: `the item reconciler, killed at ${point}`, run: async () => { const w = await itemWorld(); worlds.push(w); await killedThenCorrected(w, point); } };
  }
  const act = pick(JOB_ACTS);
  const point = pick(actKillPoints(act));
  return { name: `${act.name}, killed at ${point}`, run: async () => { const w = await actWorld(); worlds.push(w); await killedThenActed(w, act, point); } };
}

describe('the crash harness on GitHub\'s writes, randomised (issue #1959)', () => {
  for (let seed = first; seed < first + count; seed++) {
    const s = scenarioOf(seed);
    it(`seed ${seed}: ${s.name}`, async () => {
      try {
        await s.run();
      } catch (e) {
        throw new Error(`crash harness: seed ${seed}, ${s.name}: ${(e as Error).message}`, { cause: e });
      }
    }, SCENARIO_MS);
  }
});
