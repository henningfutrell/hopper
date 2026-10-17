// Issue #1614: a labelled issue the source does not take because nobody assigned it to the user is said in the log, once,
// so a person or bot that labelled it learns why no job starts. Assigned (taken) or gone, it is forgotten: when it comes
// back it is said again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; vi.restoreAllMocks(); });

const KEY = 'https://github.com/o/r/issues/7';
const unassigned: IntakeOutcome = { key: KEY, title: 't', repo: 'o/r', reason: 'not assigned to you', action: 'assign', group: 'not-assigned' };

describe('a labelled issue not assigned to the user (issue #1614)', () => {
  it('is logged once with why and what to do, and again after it was taken or gone', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const world = createWorld();
    const source = createFakeSource();
    let outcomes: IntakeOutcome[] = [unassigned, { key: 'https://github.com/o/r/issues/8', title: 'u', repo: 'o/r', reason: 'on the backburner', group: 'backburner' }];
    source.intake = () => outcomes;
    sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
    sync.start();
    await sync.syncNow();
    await sync.syncNow();
    const lines = () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('/issues/'));
    expect(lines()).toEqual([`hopper: source fake does not take ${KEY}: not assigned to you. No job starts until it is assigned (Intake: Assign to me)`]);
    outcomes = [{ key: KEY, title: 't', repo: 'o/r' }];
    await sync.syncNow();
    outcomes = [unassigned];
    await sync.syncNow();
    expect(lines()).toHaveLength(2);
  });
});
