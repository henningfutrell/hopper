// Issue #2570: a pass's listing is older than a job of its item made, or ended, while the pass ran. Another hopper on the
// same database made that job from the same Run again; it failed at once and its end was reported before this pass reached
// the item. The listing still shows the item free, but it says nothing of that job: no third job comes of it.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item } from './sync-support.ts';

const KEY = 'https://github.com/owner/repo/issues/9';

const job = (id: string, at: string, over: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'finished', approved: false, attempts: 1, createdAt: at, updatedAt: at,
  source: { source: 'fake', kind: 'fake', key: KEY }, sourceState: { sync: { claimReported: true, finalReported: true } }, ...over,
} as Job);

describe('a job of the item made while the pass ran (issue #2570)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  it('is newer than the listing: the pass makes no job of the item; the next pass judges it', async () => {
    const world = createWorld();
    world.jobs.set('old', job('old', '2026-10-01T10:00:00Z'));
    const source = createFakeSource();
    let racing = false;
    source.discover = async () => {
      source.discovers++;
      if (racing) {
        // While this pass reads GitHub, the other hopper makes the Run again's job; it fails at once, and its end is reported.
        racing = false;
        world.clock.advance(1_000);
        world.jobs.set('other', job('other', world.clock.now().toISOString(), { status: 'failed', finishedAt: world.clock.now().toISOString() }));
      }
      return [item(KEY)];
    };
    const sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
    stop = () => sync.stop();
    world.jobs.set('old', job('old', '2026-10-01T10:00:00Z', { status: 'running' }));
    sync.start();
    await sync.syncNow();
    world.jobs.set('old', job('old', '2026-10-01T10:00:00Z'));
    racing = true;
    world.clock.advance(1_000);
    await sync.syncNow();
    expect([...world.jobs.keys()]).toEqual(['old', 'other']);
    // A listing read after it: the item is free, as its labels say.
    world.clock.advance(1_000);
    await sync.syncNow();
    expect(world.jobs.size).toBe(3);
  });
});
