// The ledger's fallback read (issue #1067, part 3): GitHub's deliveries move an item when its issue closes or reopens.
// For an item no job or person acts on and that is not done (`pr_open`, `partly_done`, `failed`, `dropped`, issue #1105)
// with no news for a while — no delivery came, or none is set up —, the hopper reads its issue on GitHub in one batched
// call and records what changed as an event, so the item moves as a delivery would have moved it. An item read lately is
// not read again; with no GitHub connection, nothing is read and it says why. The first read after the start reads every
// such item, quiet or not: the rows the ledger holds are reconciled with GitHub (issue #1105).
import { describe, expect, it } from 'vitest';
import type { GitHubItemState } from '../../src/domain/drift.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { createLedgerFallbackRead, fallbackReadPick } from '../../src/work-items/fallback-read.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const OLD = '2026-10-13T10:00:00.000Z';
const NEW = '2026-10-13T11:55:00.000Z';
const QUIET = 30 * 60_000;
const url = (n: number) => `https://github.com/o/r/issues/${n}`;

const item = (n: number, state: WorkItem['state'], eventAt: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  key: url(n), state, stateSince: eventAt, eventState: state, eventAt, keptWork: [], version: 1, ...extra,
});

describe('which items the fallback read reads', () => {
  it('items no job or person acts on and not done, of a GitHub issue, with no news for the quiet time; the longest unread first', () => {
    const items = [
      item(1, 'pr_open', OLD), item(2, 'failed', OLD), item(3, 'pr_open', NEW), item(4, 'working', OLD), item(5, 'done', OLD),
      { ...item(6, 'pr_open', OLD), key: 'direct:abc' },
    ];
    expect(fallbackReadPick(items, new Map(), NOW, { quietMs: QUIET, limit: 50 })).toEqual([url(1), url(2)]);
    // Read lately: not again until the quiet time passed; the one read longest ago first.
    const lastRead = new Map([[url(1), NEW], [url(2), '2026-10-13T11:00:00.000Z']]);
    expect(fallbackReadPick(items, lastRead, NOW, { quietMs: QUIET, limit: 50 })).toEqual([url(2)]);
    expect(fallbackReadPick([item(7, 'failed', OLD), item(8, 'failed', OLD)], new Map([[url(7), '2026-10-13T11:00:00.000Z']]), NOW, { quietMs: QUIET, limit: 1 })).toEqual([url(8)]);
  });

  it('a part merged or a dropped item is read too (issue #1105): its issue may have closed as completed since', () => {
    const items = [item(1, 'partly_done', OLD), item(2, 'dropped', OLD), item(3, 'needs_you', OLD), item(4, 'waiting_for_approval', OLD)];
    expect(fallbackReadPick(items, new Map(), NOW, { quietMs: QUIET, limit: 50 })).toEqual([url(1), url(2)]);
  });
});

describe('the fallback read', () => {
  function setUp(items: WorkItem[], states: GitHubItemState[] | { problem: string }, o: { intervalMs?: number; firstMs?: number } = {}) {
    const appended: NewEvent[] = [];
    const asked: string[][] = [];
    const logs: string[] = [];
    const read = createLedgerFallbackRead({
      ledger: { list: () => items },
      events: { append: (e) => { appended.push(e); } },
      github: () => ('problem' in states ? states : { states: async (urls) => { asked.push([...urls]); return new Map(states.filter((s) => urls.includes(s.url)).map((s) => [s.url, s])); } }),
      now: () => NOW,
      log: (l) => { logs.push(l); },
      ...o,
    });
    return { read, appended, asked, logs };
  }

  it('records an issue closed or reopened on GitHub as the event a delivery records, in one batched read', async () => {
    const { read, appended, asked } = setUp(
      [item(1, 'pr_open', OLD), item(2, 'failed', OLD, { issueState: 'closed', issueReason: 'completed' }), item(3, 'failed', OLD)],
      [
        { url: url(1), state: 'closed', stateReason: 'completed' },
        { url: url(2), state: 'open' },
        { url: url(3), state: 'open' },
      ],
    );
    expect(await read.readOnce()).toBe(2);
    expect(asked).toEqual([[url(1), url(2), url(3)]]);
    expect(appended).toEqual([
      { type: 'work_item.issue_closed', data: { key: url(1), reason: 'completed', via: 'read' } },
      { type: 'work_item.issue_reopened', data: { key: url(2), via: 'read' } },
    ]);
    // Read just now: the next round reads none of them.
    expect(await read.readOnce()).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('no item to read asks GitHub nothing; no GitHub connection reads nothing and says why', async () => {
    const none = setUp([item(1, 'working', OLD)], []);
    expect(await none.read.readOnce()).toBe(0);
    expect(none.asked).toEqual([]);
    const off = setUp([item(1, 'pr_open', OLD)], { problem: 'no GitHub connection' });
    expect(await off.read.readOnce()).toBe(0);
    expect(off.appended).toEqual([]);
    expect(off.logs.join()).toContain('no GitHub connection');
  });
});

describe('the read at the start (issue #1105)', () => {
  it('reads every item not done once, quiet or not and past the limit', async () => {
    const appended: NewEvent[] = [];
    const asked: string[][] = [];
    const items = [item(1, 'pr_open', NEW), item(2, 'partly_done', NEW), item(3, 'dropped', OLD), item(4, 'done', OLD)];
    const read = createLedgerFallbackRead({
      ledger: { list: () => items },
      events: { append: (e) => { appended.push(e); } },
      github: () => ({ states: async (urls) => { asked.push([...urls]); return new Map(urls.map((u) => [u, { url: u, state: 'closed', stateReason: 'completed' }])); } }),
      now: () => NOW,
      log: () => undefined,
      limit: 1,
      firstMs: 1,
      intervalMs: 60_000,
    });
    read.start();
    await new Promise((r) => setTimeout(r, 30));
    await read.stop();
    expect(asked).toEqual([[url(3), url(1), url(2)]]);
    expect(appended.map((e) => e.data.key)).toEqual([url(1), url(2), url(3)]);
  });
});
