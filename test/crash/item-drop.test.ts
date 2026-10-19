// A database connection dropped inside a transaction of more than one statement (issue #1954, design.md "The crash
// harness"): the item reconciler's block of #1 writes its `work_item.reconciled` event, the ledger's move and its label
// rows in one transaction. The first hopper reaches Postgres through a proxy that ends the connection at the block's
// first outbox row — before Postgres reads it, or once Postgres ran it, with the transaction still open. Postgres then
// rolls the whole transaction back: no event, no move, no row. The hopper is killed, and a second one blocks the item
// once, with its labels changed on GitHub once.
import { afterEach, describe, expect, it } from 'vitest';
import { openUserStore } from '../../src/store/user-store.ts';
import { stallingProxy, type StallingProxy } from '../support/stalling-proxy.ts';
import { stopHosts } from './harness.ts';
import { blockedOnce, endHeld, issueUrl, itemOf, itemWorld, SCENARIO_MS, type ItemWorld } from './item-world.ts';
import { openRows } from './outbox-world.ts';
import { randomUUID } from 'node:crypto';

const worlds: ItemWorld[] = [];
const proxies: StallingProxy[] = [];
afterEach(async () => {
  await stopHosts();
  for (const p of proxies.splice(0)) await p.close();
  for (const w of worlds.splice(0)) await w.close();
});

/** The statement that keeps an outbox row (src/store/github-outbox.ts `add`): the block's second statement and later. */
const ROW = 'INSERT INTO github_outbox';

describe('the item reconciler\'s block with its database connection dropped inside its transaction (issue #1954)', () => {
  for (const after of [false, true]) {
    it(`dropped ${after ? 'after' : 'before'} the block's first outbox row ran: nothing of the block is kept, and the next hopper blocks the item once`, async () => {
      const w = await itemWorld();
      worlds.push(w);
      const proxy = await stallingProxy(w.url);
      proxies.push(proxy);
      const a = await w.host({ connect: true, databaseUrl: proxy.url });
      const { dropped } = await proxy.drop({ at: ROW, nth: 1, after });
      w.seed(['stale']);
      const stop = w.due();
      try {
        await dropped;
        await a.kill();
        expect(itemOf(w, 1)?.state).toBe('pr_open');
        const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
        try { expect(store.events.recent(10, ['work_item.reconciled']).filter((e) => e.data.key === issueUrl(1))).toEqual([]); } finally { store.close(); }
        expect(openRows(w)).toEqual([]);
        endHeld(w);
        await blockedOnce(w, await w.host());
      } finally { stop(); }
    }, SCENARIO_MS);
  }
});
