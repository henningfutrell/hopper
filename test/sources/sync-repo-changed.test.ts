// Issue #1079: a GitHub delivery says a repository changed. Each running source whose job repository it is syncs soon
// after — one timed (due) sync for a burst of deliveries, not one each —, before its timer. A source that takes none,
// or that names the repository no job repository, does not sync.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceSync, DELIVERY_SYNC_MS } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, settle } from './sync-support.ts';

const POLL = 60 * 60_000;
let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { vi.useRealTimers(); await sync?.stop(); sync = undefined; });

function setup() {
  const world = createWorld();
  const mine = createFakeSource('mine');
  const changed: string[] = [];
  const due: (boolean | undefined)[] = [];
  mine.repoChanged = (repo) => { changed.push(repo); return repo === 'owner/repo'; };
  const discover = mine.discover;
  mine.discover = (d) => { due.push(d?.due); return discover(d); };
  const other = createFakeSource('other');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sync = createSourceSync({ sources: [mine, other], host: world.host, clock: world.clock, pollMs: () => POLL });
  const pass = async (ms: number) => { world.clock.advance(ms); vi.advanceTimersByTime(ms); await settle(); };
  return { sync, mine, other, changed, due, pass };
}

describe('a sync after a GitHub delivery (issue #1079)', () => {
  it('names the sources whose job repository it is, and syncs each once, soon after a burst', async () => {
    const { sync, mine, other, changed, due, pass } = setup();
    sync.start();
    await settle();
    const before = { mine: mine.discovers, other: other.discovers };
    expect(sync.repoChanged('owner/repo')).toEqual(['mine']);
    expect(sync.repoChanged('owner/repo')).toEqual(['mine']);
    expect(sync.repoChanged('owner/repo')).toEqual(['mine']);
    expect(changed).toEqual(['owner/repo', 'owner/repo', 'owner/repo']);
    await pass(DELIVERY_SYNC_MS - 1);
    expect(mine.discovers).toBe(before.mine);
    await pass(1);
    expect(mine.discovers).toBe(before.mine + 1);
    expect(due.at(-1)).toBe(true); // a timed sync: only what is due is read
    expect(other.discovers).toBe(before.other);
    await pass(DELIVERY_SYNC_MS);
    expect(mine.discovers).toBe(before.mine + 1);
  });

  it('a repository no source takes starts no sync', async () => {
    const { sync, mine, pass } = setup();
    sync.start();
    await settle();
    const before = mine.discovers;
    expect(sync.repoChanged('someone/else')).toEqual([]);
    await pass(DELIVERY_SYNC_MS);
    expect(mine.discovers).toBe(before);
  });

  it('a stopped sync loop takes none', async () => {
    const { sync, changed } = setup();
    expect(sync.repoChanged('owner/repo')).toEqual([]);
    expect(changed).toEqual([]);
  });
});
