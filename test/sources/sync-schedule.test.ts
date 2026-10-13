// Issue #812: a source's next sync time (`nextSyncAt`) is when its timer fires, and a running sync shows no stale one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceStatus } from '../../src/domain/sources.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, settle } from './sync-support.ts';

const POLL = 1000;
let sync: ReturnType<typeof createSourceSync> | undefined;
let gates: (() => void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const stopped = sync?.stop();
  for (let i = 0; i < 5; i++) { gates.splice(0).forEach((g) => g()); await settle(); } // let a held discover end
  await stopped; sync = undefined;
});

/** A source whose discover waits until it is let go, one gate per call. */
function gated() {
  const world = createWorld();
  const source = createFakeSource();
  gates = [];
  const orig = source.discover;
  source.discover = async () => { await new Promise<void>((r) => gates.push(r)); return orig(); };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const seen: SourceStatus[] = [];
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => POLL });
  sync.onStatus((s) => seen.push(s));
  const pass = (ms: number) => { world.clock.advance(ms); vi.advanceTimersByTime(ms); };
  const release = async () => { await settle(); gates.shift()!(); await settle(); };
  return { world, source, sync, seen, pass, release };
}

describe('next sync time', () => {
  it('fires at the shown next sync time when a sync was asked for while one ran', async () => {
    const { world, sync, pass, release } = gated();
    sync.start(); // sync A
    const asked = sync.syncNow(); // sync B, queued behind A
    await release(); // A ends and schedules
    pass(500);
    await release(); // B ends and schedules
    await asked;
    const next = Date.parse(sync.statuses()[0]!.nextSyncAt!);
    expect(next).toBe(world.clock.now().getTime() + POLL);
    pass(POLL - 1);
    await settle();
    expect(gates).toHaveLength(0); // no sync starts before the shown time
    pass(1);
    await settle();
    expect(gates).toHaveLength(1); // one sync starts at it
  });

  it('shows a running sync and no next time while it runs, and the true next time after', async () => {
    const { world, sync, seen, release } = gated();
    sync.start();
    await release(); // the first sync ends
    expect(sync.statuses()[0]!.nextSyncAt).toBeTruthy();
    seen.length = 0;
    const asked = sync.syncNow();
    await settle();
    const running = sync.statuses()[0]!;
    expect(running.syncing).toBe(true);
    expect(running.nextSyncAt).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ syncing: true }); // the UI is told at once
    await release();
    await asked;
    const done = sync.statuses()[0]!;
    expect(done.syncing).toBeUndefined();
    expect(done.nextSyncAt).toBe(new Date(world.clock.now().getTime() + POLL).toISOString());
    expect(seen.at(-1)?.nextSyncAt).toBe(done.nextSyncAt);
  });
});

describe('what a sync asks the source to read (issue #985)', () => {
  it('a timed sync asks for what is due; the first sync and a sync asked for (Sync now) ask for everything', async () => {
    const world = createWorld();
    const source = createFakeSource();
    const asked: unknown[] = [];
    const orig = source.discover;
    source.discover = async (o) => { asked.push(o); return orig(o); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => POLL });
    sync.start();
    await settle();
    world.clock.advance(POLL);
    vi.advanceTimersByTime(POLL);
    await settle();
    await sync.syncNow();
    expect(asked).toEqual([undefined, { due: true }, undefined]);
  });
});
