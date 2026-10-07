// Job sources follow the plugins config without a restart (issue #356): the sync loop takes the
// running sources as they are now. An added source is synced at once; a changed one (same name, new
// instance) is used from its next sync on, for the jobs it already has too; a removed one discovers
// nothing more, still checks and reports its own jobs until they end, and then goes.

import { afterEach, describe, expect, it } from 'vitest';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; });

function setup() {
  const world = createWorld();
  const first = createFakeSource('gh');
  sync = createSourceSync({ sources: [first], host: world.host, clock: world.clock, pollMs: () => 60_000 });
  sync.start();
  return { world, first, sync };
}

describe('sync loop: the sources follow the plugins config live (issue #356)', () => {
  it('an added source is synced at once and listed', async () => {
    const { world, first, sync } = setup();
    await sync.syncNow();
    const added = createFakeSource('app');
    added.items = [item('k1')];
    sync.setSources([first, added]);
    await sync.syncNow('app');
    expect(added.discovers).toBeGreaterThan(0);
    expect(world.jobs.size).toBe(1);
    expect(sync.statuses().map((s) => s.name)).toEqual(['gh', 'app']);
    expect(sync.source('app')).toBe(added);
  });

  it('a changed source (same name, new instance) is used from its next sync, for the jobs it already has too', async () => {
    const { world, first, sync } = setup();
    first.items = [item('k1')];
    await sync.syncNow();
    await settle();
    expect(first.reports.map((r) => r.kind)).toEqual(['claimed']);
    const next = createFakeSource('gh');
    next.items = [item('k1'), item('k2')];
    sync.setSources([next]);
    await sync.syncNow();
    expect(world.jobs.size).toBe(2);
    world.patchJob('job-1', { status: 'finished' });
    world.emit('job.finished', 'job-1');
    await settle();
    await sync.syncNow();
    expect(next.reports.map((r) => `${r.kind} ${r.job.id}`)).toEqual(expect.arrayContaining(['claimed job-2', 'finished job-1']));
    expect(first.reports.map((r) => r.kind)).toEqual(['claimed']);
    expect(sync.statuses()).toEqual([expect.objectContaining({ name: 'gh', jobsCreated: 2 })]);
  });

  it('a removed source discovers nothing more, still reports its running job, and goes once that job ended and is reported', async () => {
    const { world, first, sync } = setup();
    first.items = [item('k1')];
    await sync.syncNow();
    sync.setSources([]);
    first.items = [item('k1'), item('k2')];
    const before = first.discovers;
    await sync.syncNow();
    expect(first.discovers).toBe(before);
    expect(world.jobs.size).toBe(1);
    expect(world.jobs.get('job-1')!.status).not.toBe('cancelled');
    expect(sync.statuses()).toEqual([expect.objectContaining({ name: 'gh', activeJobs: 1, detail: expect.objectContaining({ paused: 'removed from the plugins config' }) })]);
    expect(sync.source('gh')).toBe(first);
    world.patchJob('job-1', { status: 'finished' });
    world.emit('job.finished', 'job-1');
    await settle();
    await sync.syncNow();
    expect(first.reports.map((r) => r.kind)).toEqual(['claimed', 'finished']);
    expect(sync.statuses()).toEqual([]);
    expect(sync.source('gh')).toBeUndefined();
  });

  it('a removed source added back before it went is synced as before', async () => {
    const { first, sync } = setup();
    first.items = [item('k1')];
    await sync.syncNow();
    sync.setSources([]);
    sync.setSources([first]);
    first.items = [item('k1'), item('k2')];
    await sync.syncNow();
    expect(sync.statuses()[0]!.detail.paused).toBeUndefined();
    expect(sync.statuses()[0]).toMatchObject({ jobsCreated: 2 });
  });
});
