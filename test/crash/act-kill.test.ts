// The crash harness on a person's acts on a job (issue #1959 part 3, design.md "The GitHub outbox under crashes and
// faults"): Merge now, Close PR and Run again are rows of the GitHub outbox that the sync loop's own act sends. A hopper
// killed with SIGKILL before the send, inside it — after GitHub merged, after the hopper closed the issue, after the
// source gave the item back — or once it answered, before the row is `sent`, leaves the row to a second hopper on the
// same database. GitHub then holds each effect once: the pull request merged or closed once, the issue closed with one
// comment, and one new job of the item; and each act is recorded once.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { actWorld, JOB_ACTS, killedThenActed, killPointsOf, SCENARIO_MS, type ActWorld } from './act-world.ts';

const worlds: ActWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('a person\'s act on a job, the hopper killed at each kill point of its send (issue #1959)', () => {
  for (const act of JOB_ACTS) {
    for (const point of killPointsOf(act)) {
      it(`${act.name}, killed at ${point}: the next hopper sends what is left, each effect once`, async () => {
        const w = await actWorld();
        worlds.push(w);
        await killedThenActed(w, act, point);
      }, SCENARIO_MS);
    }
  }
});
