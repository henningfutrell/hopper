// A paused source (gh while the app exists; the app while none is) discovers nothing new but
// still checks and reports its own active jobs.

import { afterEach, describe, expect, it } from 'vitest';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; });

function setup(initial?: string) {
  const world = createWorld();
  const source = createFakeSource('gh');
  let reason = initial;
  source.paused = () => reason;
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000, progressThrottleMs: () => 0 });
  sync.start();
  return { world, source, sync, pause: (r: string | undefined) => { reason = r; } };
}

describe('sync loop: paused sources', () => {
  it('paused with no active jobs: no discover, state disabled, detail.paused = the reason', async () => {
    const { source, sync } = setup('github app configured');
    source.items = [item('k1')];
    await sync.syncNow();
    expect(source.discovers).toBe(0);
    expect(sync.statuses()[0]).toMatchObject({ state: 'disabled', itemsSeen: 0, detail: expect.objectContaining({ paused: 'github app configured' }) });
  });

  it('paused with active jobs: still checks and reports them, state ok with detail.paused', async () => {
    const { world, source, sync, pause } = setup();
    source.items = [item('k1')];
    await sync.syncNow();
    expect(world.jobs.size).toBe(1);
    pause('github app configured');
    const before = source.discovers;
    source.items = [item('k1'), item('k2')];
    source.signals = [{ kind: 'cancel', jobId: 'job-1', reason: 'issue closed' }];
    await sync.syncNow();
    await settle();
    expect(source.discovers).toBe(before);
    expect(world.jobs.size).toBe(1);
    expect(world.calls.cancel).toEqual([['job-1', 'issue closed']]);
    expect(source.reports.map((r) => r.kind)).toEqual(['claimed', 'cancelled']);
    const st = sync.statuses()[0]!;
    expect(st.detail.paused).toBe('github app configured');
  });

  it('paused while a job is active reports ok; once the job is done and idle → disabled', async () => {
    const { world, source, sync, pause } = setup();
    source.items = [item('k1')];
    await sync.syncNow();
    pause('github app configured');
    await sync.syncNow();
    expect(sync.statuses()[0]).toMatchObject({ state: 'ok', activeJobs: 1 });
    world.patchJob('job-1', { status: 'finished' });
    await sync.syncNow();
    expect(sync.statuses()[0]).toMatchObject({ state: 'disabled', activeJobs: 0 });
  });

  it('unpaused again: discovers and drops detail.paused', async () => {
    const { source, sync, pause } = setup('x');
    await sync.syncNow();
    pause(undefined);
    source.items = [item('k1')];
    await sync.syncNow();
    expect(source.discovers).toBe(1);
    expect(sync.statuses()[0]).toMatchObject({ state: 'ok', jobsCreated: 1 });
    expect(sync.statuses()[0]!.detail.paused).toBeUndefined();
  });
});
