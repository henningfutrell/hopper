// A paused source (gh while the app exists; the app while none is) discovers nothing new but
// still checks and reports its own active jobs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; vi.restoreAllMocks(); });

function setup(initial?: string) {
  const world = createWorld();
  const source = createFakeSource('gh');
  let reason = initial;
  source.paused = () => reason;
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
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

  // Issue #1351: the pass is told why it takes nothing new, so its traffic line says it on every pass.
  it('tells its pass why it takes nothing new, and nothing once unpaused', async () => {
    const { source, sync, pause } = setup('no GitHub account connected');
    const idle: (string | undefined)[] = [];
    source.pass = async (run, why) => { idle.push(why); return run(); };
    await sync.syncNow();
    pause(undefined);
    await sync.syncNow();
    expect(idle).toEqual(['no GitHub account connected', undefined]);
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

  // Issue #1351: a paused pass asks GitHub nothing, so its traffic line reads "REST 0, GraphQL 0": the log says why, once.
  it('says in the log why it is paused, once when it starts or changes, and once when it ends', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sync, pause } = setup('no GitHub account connected');
    await sync.syncNow();
    await sync.syncNow();
    pause('sign in again');
    await sync.syncNow();
    pause(undefined);
    await sync.syncNow();
    await sync.syncNow();
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('hopper: source gh '));
    expect(said).toEqual([
      'hopper: source gh paused, nothing new is taken: no GitHub account connected',
      'hopper: source gh paused, nothing new is taken: sign in again',
      'hopper: source gh no longer paused',
    ]);
  });
});
