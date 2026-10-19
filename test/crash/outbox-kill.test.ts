// The crash harness on the GitHub outbox (issue #1959, design.md "The crash harness"): a hopper killed with SIGKILL before
// or after each call of each write kind — a call GitHub took and the hopper never recorded among them — leaves the rows to
// a second hopper on the same database, which sends what is left: GitHub holds each intended effect once, the comment is
// found by its key and not posted again, and each act's event is recorded once. Two hoppers live at once never send the
// same row: a comment held at GitHub while the second starts is posted once.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../support/wait.ts';
import { stopHosts } from './harness.ts';
import { act, killedThenSent, openRows, OUTBOX_KILL_POINTS, outboxWorld, REPO, SCENARIO_MS, writtenOnce, type OutboxWorld } from './outbox-world.ts';

const worlds: OutboxWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

describe('the GitHub outbox killed at each call of each write kind (issue #1959)', () => {
  for (const point of OUTBOX_KILL_POINTS) {
    it(`killed at ${point}: the next hopper sends what is left, each effect once`, async () => {
      const w = await outboxWorld();
      worlds.push(w);
      await killedThenSent(w, point);
    }, SCENARIO_MS);
  }
});

describe('two hoppers on one database (issue #1959)', () => {
  it('a comment one hopper is posting, held at GitHub, is not posted by a second hopper that starts meanwhile', async () => {
    const w = await outboxWorld();
    worlds.push(w);
    const a = await w.host({ connect: true });
    const held = w.github.hold(`POST /repos/${REPO}/issues/1/comments`);
    await act(w, a);
    await waitFor(() => (held.held() === 1 ? true : undefined), { what: 'the comment held at GitHub' });
    const b = await w.host();
    // The second hopper's sends run while the first holds the rows: every 5 s, from its start.
    await new Promise((res) => setTimeout(res, 6_000));
    expect(held.held()).toBe(1);
    expect(openRows(w).filter((r) => r.op === 'comment')).toEqual([{ state: 'sending', op: 'comment' }]);
    held.release();
    await writtenOnce(w, b);
    expect(w.github.state.repos.get(REPO)!.issues.get(1)!.comments).toHaveLength(1);
  }, SCENARIO_MS);
});
