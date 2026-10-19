// The crash harness on a job's push (issue #1954, design.md "The crash harness"): a hopper killed with SIGKILL before the
// git broker sends the job's push to GitHub, once GitHub answered it and before the broker records it, or at a boundary of
// the push's `git-push` saga, leaves the saga to a second hopper on the same database. That hopper records the push once:
// done when GitHub holds the branch, failed when it does not. The job's git sends the push again, and GitHub holds it.
import { afterEach, describe, it } from 'vitest';
import { stopHosts } from './harness.ts';
import { killedThenSettled, PUSH_KILL_POINTS, pushWorld, SCENARIO_MS, type PushWorld } from './push-world.ts';

const worlds: PushWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('a job\'s push killed at each kill point (issue #1954)', () => {
  for (const point of PUSH_KILL_POINTS) {
    it(`killed at ${point}: the next hopper records the push once, as GitHub holds it`, async () => {
      const w = await pushWorld();
      worlds.push(w);
      await killedThenSettled(w, point);
    }, SCENARIO_MS);
  }
});
