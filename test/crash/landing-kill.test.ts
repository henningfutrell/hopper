// The crash harness on landing batches (issues #1954, #1589, design.md "The crash harness" part 8): a hopper killed with
// SIGKILL after each GitHub write of the batch runner, before the event that records it, leaves the batch to a second
// hopper on the same database. That hopper takes it to the end a clean run reaches: each pull request, revert and issue
// exists once at GitHub, and no pull request or branch of the hopper's is left.
//
// Feature: a kill between a GitHub write of the landing batches and its event
//   Scenario: a clean run writes what the kill points name, and ends with each effect once
//   Scenario Outline: killed after <write> #<n>: the next hopper ends the batch, each effect once
import { afterEach, describe, expect, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { cleanRun, killedThenEnded, LANDING_SCENARIOS, landingWorld, pointsOf, SCENARIO_MS, type LandingWorld } from './landing-world.ts';

const worlds: LandingWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('landing batches killed between a GitHub write and its event (issues #1954, #1589)', () => {
  for (const s of LANDING_SCENARIOS) {
    describe(s.name, () => {
      it('a clean run: its writes are the kill points, and it ends with each effect once', async () => {
        const w = await landingWorld(s);
        worlds.push(w);
        expect(pointsOf(await cleanRun(w, s))).toEqual(s.points);
      }, SCENARIO_MS);

      for (const point of s.points) {
        it(`killed at ${point}: the next hopper ends the batch, each effect once`, async () => {
          const w = await landingWorld(s);
          worlds.push(w);
          await killedThenEnded(w, s, point);
        }, SCENARIO_MS);
      }
    });
  }
});
