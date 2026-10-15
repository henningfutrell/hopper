// A source that is enabled but not configured (issue #1243): its setup problem names what is missing, it runs no empty
// sync pass that looks like a healthy zero, it is said once in the log, and it clears by itself at the next sync once the
// config is complete.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupProblem } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; vi.restoreAllMocks(); });

const MISSING: SetupProblem = { missing: ['appId', 'slug', 'private key'], reason: 'appId, slug, private key not set', help: 'github-app-setup' };

function setup(initial: SetupProblem | undefined) {
  const world = createWorld();
  const source = createFakeSource('github-app');
  let problem = initial;
  let passes = 0;
  source.setupProblem = () => problem;
  source.paused = () => problem?.reason;
  source.pass = async (run) => { passes++; return run(); };
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
  sync.start();
  return { world, source, sync, passes: () => passes, configure: (p: SetupProblem | undefined) => { problem = p; } };
}

describe('sync loop: a source not configured (issue #1243)', () => {
  it('names what is missing, runs no sync pass, is never ok, and is said once in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, sync, passes } = setup(MISSING);
    source.items = [item('k1')];
    await sync.syncNow();
    await sync.syncNow();
    expect(source.discovers).toBe(0);
    expect(passes()).toBe(0);
    const st = sync.statuses()[0]!;
    expect(st).toMatchObject({ state: 'needs-setup', itemsSeen: 0, setupProblem: MISSING });
    expect(st.lastOkAt).toBeUndefined();
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('not configured'));
    expect(said).toEqual(['hopper: source github-app not configured: appId, slug, private key not set']);
  });

  it('config completed: the setup problem clears at the next sync, without a restart, and the source works', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, sync, passes, configure } = setup(MISSING);
    await sync.syncNow();
    configure(undefined);
    source.items = [item('k1')];
    await sync.syncNow();
    expect(passes()).toBe(1);
    expect(source.discovers).toBe(1);
    const st = sync.statuses()[0]!;
    expect(st).toMatchObject({ state: 'ok', jobsCreated: 1 });
    expect(st.setupProblem).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('hopper: source github-app configured');
  });

  it('with jobs of its own still to report, it runs its pass for them and still names its setup problem', async () => {
    const { world, source, sync, passes, configure } = setup(undefined);
    source.items = [item('k1')];
    await sync.syncNow();
    expect(world.jobs.size).toBe(1);
    configure(MISSING);
    await sync.syncNow();
    expect(passes()).toBe(2);
    expect(source.discovers).toBe(1);
    expect(sync.statuses()[0]).toMatchObject({ setupProblem: MISSING });
  });
});
