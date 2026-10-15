// Issue #1352: an item belongs to its repository and issue, not to the source that first saw it. A job whose source was
// removed (the polling `github-account`) runs again through a running source that adopts it, and the new job is that
// source's; with no such source, Run again says why. A cancelled job runs again too.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle, type FakeSource } from './sync-support.ts';

const REPO = 'owner/repo';
const KEY = `https://github.com/${REPO}/issues/7`;

describe('Run again on a job whose source was removed (issue #1352)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  function setup(adopts: boolean, sourceName = 'github-account') {
    const world = createWorld();
    const taken: Job[] = [];
    const app: FakeSource = Object.assign(createFakeSource('github-app'), {
      async rerun(job: Job) { taken.push(job); return item(KEY, { repo: REPO }); },
      adopts: (job: Job) => adopts && job.source?.repo === REPO,
    });
    world.jobs.set('old', {
      id: 'old', spec: { executor: 'test', payload: {} }, priority: 50, status: 'failed', approved: false, attempts: 1,
      createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
      // Its end was never told to the removed source.
      source: { source: sourceName, kind: sourceName, key: KEY, url: KEY, repo: REPO, number: 7 },
    } as Job);
    const sync = createSourceSync({ sources: [app], host: world.host, clock: world.clock, pollMs: () => 60_000 });
    stop = () => sync.stop();
    sync.start();
    return { world, sync, taken };
  }

  it('a running source that takes its repository gives the item back, and the new job is that source\'s', async () => {
    const { world, sync, taken } = setup(true);
    await settle();
    const r = await sync.rerun('old');
    expect(r.ok).toBe(true);
    expect(taken.map((j) => j.id)).toEqual(['old']);
    const next = world.store.jobs.getBySourceKey(KEY)!;
    expect(next.id).not.toBe('old');
    expect(next.source).toMatchObject({ source: 'github-app', key: KEY });
    // Its removed source is told nothing more: its end counts as told.
    expect(world.store.jobs.get('old')!.sourceState?.sync).toMatchObject({ finalReported: true });
  });

  it('no running source takes its repository: refused, and why', async () => {
    const { sync, taken } = setup(false);
    await settle();
    const r = await sync.rerun('old');
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(r.ok ? '' : r.message).toContain('no running source takes its repository');
    expect(sync.takesBack('old')).toMatchObject({ ok: false });
    expect(taken).toEqual([]);
  });

  it('a cancelled job runs again', async () => {
    const { world, sync } = setup(true);
    world.patchJob('old', { status: 'cancelled' });
    await settle();
    const r = await sync.rerun('old');
    expect(r.ok).toBe(true);
    expect(world.store.jobs.getBySourceKey(KEY)!.id).not.toBe('old');
  });
});
