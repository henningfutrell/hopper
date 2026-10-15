// Poll backoff (issue #1264): a source's timed syncs that find nothing changed come further apart, up to a limit; a
// change, or a sync a person asked for, brings back its poll interval. Each status says its poll interval, the interval to
// its next timed sync, and the calls its passes made in the last hour and day, as the hopper's database keeps them.
// Asserted on the intervals the loop computes, not on wall-clock time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceCallLog } from '../../src/domain/ports.ts';
import { backedOffMs, MAX_BACKOFF_FACTOR } from '../../src/sources/poll-backoff.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

const POLL = 1000;
let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { vi.useRealTimers(); await sync?.stop(); sync = undefined; });

function looped(o: { calls?: SourceCallLog } = {}) {
  const world = createWorld();
  const source = createFakeSource();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => POLL, backoff: () => true, ...(o.calls ? { calls: o.calls } : {}) });
  const s = sync;
  const status = () => s.statuses()[0]!;
  /** Let the next timed sync run: its interval passes. */
  const timed = async () => { const ms = status().nextPollMs!; world.clock.advance(ms); vi.advanceTimersByTime(ms); await settle(); };
  return { world, source, sync: s, status, timed };
}

describe('the backoff interval', () => {
  it('doubles for each timed sync that found nothing changed, up to the limit', () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => backedOffMs(POLL, n))).toEqual([POLL, 2 * POLL, 4 * POLL, 8 * POLL, 8 * POLL, 8 * POLL]);
    expect(MAX_BACKOFF_FACTOR).toBe(8);
  });
});

describe('poll backoff in the sync loop (issue #1264)', () => {
  it('consecutive unchanged syncs increase the next interval; a change resets it', async () => {
    const { source, sync, status, timed } = looped();
    sync.start();
    await settle();
    expect(status()).toMatchObject({ pollMs: POLL, nextPollMs: POLL }); // the first sync was asked for
    await timed();
    expect(status().nextPollMs).toBe(2 * POLL);
    await timed();
    expect(status().nextPollMs).toBe(4 * POLL);
    source.items = [item('a')];
    await timed();
    expect(status().nextPollMs).toBe(POLL); // a new item is a change
  });

  it('the same answer again (a 304 answered from the cache) is no change: no job is made or changed, and the interval grows', async () => {
    const { world, source, sync, status, timed } = looped();
    const answer = [item('a')];
    source.items = answer;
    sync.start();
    await settle();
    expect(world.calls.ingest).toHaveLength(1);
    // Its job ended and was told: the source lists it no more, and GitHub answers 304 to each poll from then on.
    world.patchJob('job-1', { status: 'finished', sourceState: { sync: { claimReported: true, finalReported: true } } });
    source.items = [];
    await timed(); // the listing changed: the item is gone
    expect(status().nextPollMs).toBe(POLL);
    await timed();
    await timed();
    expect(status().nextPollMs).toBe(4 * POLL);
    expect(world.calls.ingest).toHaveLength(1);
    expect(world.calls.refresh).toHaveLength(0);
    expect(world.jobs.get('job-1')!.status).toBe('finished');
  });

  it('a sync a person asked for (Sync now) resets it', async () => {
    const { sync, status, timed } = looped();
    sync.start();
    await settle();
    await timed();
    await timed();
    expect(status().nextPollMs).toBe(4 * POLL);
    await sync.syncNow();
    expect(status().nextPollMs).toBe(POLL);
  });

  it('a source the loop does not back off keeps its poll interval', async () => {
    const world = createWorld();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sync = createSourceSync({ sources: [createFakeSource()], host: world.host, clock: world.clock, pollMs: () => POLL });
    sync.start();
    await settle();
    world.clock.advance(POLL);
    vi.advanceTimersByTime(POLL);
    await settle();
    expect(sync.statuses()[0]).toMatchObject({ pollMs: POLL, nextPollMs: POLL });
  });
});

describe('the calls each pass made (issue #1264)', () => {
  it('are kept in the call log, and the status shows the last hour and day from it', async () => {
    const kept: { source: string; at: string; calls: number }[] = [];
    const calls: SourceCallLog = {
      record: (source, at, n) => { kept.push({ source, at, calls: n }); },
      volume: (source) => {
        const n = kept.filter((k) => k.source === source).reduce((a, k) => a + k.calls, 0);
        return { lastHour: n, lastDay: n };
      },
    };
    const { source, sync, status } = looped({ calls });
    source.passCalls = () => 7;
    sync.start();
    await settle();
    expect(kept).toEqual([{ source: 'fake', at: '2026-10-02T10:00:00.000Z', calls: 7 }]);
    expect(status().calls).toEqual({ lastHour: 7, lastDay: 7 });
  });
});
