// The crash harness on a person's acts on a job (issue #1959 part 3, design.md "The GitHub outbox under crashes and
// faults"): Merge now, Close PR and Run again are rows of the GitHub outbox that the sync loop's own act sends. A hopper
// killed with SIGKILL before the send, inside it — after GitHub merged, after the hopper closed the issue, after the
// source gave the item back — or once it answered, before the row is `sent`, leaves the row to a second hopper on the
// same database. GitHub then holds each effect once: the pull request merged or closed once, the issue closed with one
// comment, and one new job of the item; and each act is recorded once.
import { afterEach, describe, expect, it } from 'vitest';
import { killedAt, stopHosts } from './harness.ts';
import { endClaims } from './outbox-world.ts';
import { actedOnce, actWorld, JOB_ACTS, killPointsOf, press, SCENARIO_MS, type ActWorld } from './act-world.ts';

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
        const a = await w.host({ killPoint: point, connect: true });
        w.seed();
        // Answered at once; a kill as the answer goes out answers nothing.
        expect([202, 0]).toContain(await press(w, a, act));
        await killedAt(a, point);
        endClaims(w);
        const b = await w.host();
        await actedOnce(w, b, act);
      }, SCENARIO_MS);
    }
  }
});
