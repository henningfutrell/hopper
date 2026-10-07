// A source that keeps failing stops intake without a sound (issue #358): the sync loop logs a source's
// error once when it changes (and once when the source is ok again), and a source in error for longer than
// the stall threshold records `source.stalled` once per run of failures — which the notifiers send.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; vi.restoreAllMocks(); });

const MINUTE = 60_000;

function setup() {
  const world = createWorld();
  const source = createFakeSource('github-account');
  const events: DomainEvent[] = [];
  world.store.events.subscribe((e) => { events.push(e); });
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60 * MINUTE, stallAfterMs: 30 * MINUTE });
  sync.start();
  return { world, source, sync, stalled: () => events.filter((e) => e.type === 'source.stalled') };
}

describe('sync loop: a failing source', () => {
  it('records source.stalled once the source has been in error past the threshold, once per run of failures', async () => {
    const { world, source, sync, stalled } = setup();
    source.discoverError = new Error('GitHub refused the token');
    await sync.syncNow();
    const since = world.clock.now().toISOString();
    expect(sync.statuses()[0]).toMatchObject({ state: 'error', lastError: 'GitHub refused the token' });
    world.clock.advance(29 * MINUTE);
    await sync.syncNow();
    expect(stalled()).toHaveLength(0);

    world.clock.advance(2 * MINUTE);
    await sync.syncNow();
    expect(stalled()).toHaveLength(1);
    expect(stalled()[0]!.data).toEqual({ source: 'github-account', kind: 'fake', error: 'GitHub refused the token', since });
    world.clock.advance(60 * MINUTE);
    await sync.syncNow();
    expect(stalled()).toHaveLength(1);

    // Ok again ends the run; a new run of failures is told again once it passes the threshold.
    delete source.discoverError;
    await sync.syncNow();
    source.discoverError = new Error('GitHub is down');
    await sync.syncNow();
    world.clock.advance(31 * MINUTE);
    await sync.syncNow();
    expect(stalled()).toHaveLength(2);
    expect(stalled()[1]!.data).toMatchObject({ error: 'GitHub is down' });
  });

  it('logs the error once when it changes, and once when the source is ok again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { source, sync } = setup();
    source.discoverError = new Error('GitHub refused the token');
    await sync.syncNow();
    await sync.syncNow();
    await sync.syncNow();
    const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('source github-account'));
    expect(lines()).toEqual(['hopper: source github-account failed: GitHub refused the token']);
    source.discoverError = new Error('GitHub is down');
    await sync.syncNow();
    expect(lines()).toHaveLength(2);
    delete source.discoverError;
    await sync.syncNow();
    await sync.syncNow();
    expect(info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('source github-account'))).toEqual(['hopper: source github-account is ok again']);
  });
});
