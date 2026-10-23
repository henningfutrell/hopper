// Issue #2504 part 13: the cleanup at a job's end closes its herdr pane entries as its route says. Through the job's own
// executor, which closes the pane: reaped. Through the machine as it is reached now (issue #2490), which reaps but closes
// no pane: failed, with why. A person who marks a deferred cleanup done (closed by hand): reaped, with that reason.
import { describe, expect, it } from 'vitest';
import { createCleanups } from '../../src/engine/cleanup.ts';
import { PANE_CLOSED_BY_HAND, PANE_NOT_REACHED, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const PANE: LedgerEntry = { jobId: 'j', machineId: 'm1', kind: 'herdr_pane', locator: 'w1-3', createdAt: '2026-10-22T00:00:00.000Z', state: 'live' };

function setup(o: { route: 'own' | 'machine' | 'none'; deferred?: boolean }) {
  let job: Record<string, unknown> = {
    id: 'j', status: 'finished', spec: { executor: 'herdr' }, source: { key: 'gh:o/r#1' },
    executorState: { cwd: '/w', laneId: 'm1/lane-1', paneId: 'w1-3' },
    ...(o.deferred ? { cleanupDeferred: { at: '2026-10-20T00:00:00.000Z', error: 'herdr: not reached' } } : {}),
  };
  let entries: LedgerEntry[] = [PANE];
  const closes: unknown[][] = [];
  const store = {
    jobs: { list: () => [job], get: () => job, update: (_id: string, patch: Record<string, unknown>) => { job = { ...job, ...patch }; return job; } },
    events: { append: () => {}, recent: () => [] },
    tx: <T>(f: () => T): T => f(),
    resourceLedger: {
      forJob: () => entries, open: () => entries, retain: () => {},
      close: (...args: unknown[]) => {
        closes.push(args);
        entries = entries.map((e) => (e.kind === args[1] && e.locator === args[2] ? { ...e, state: args[3] as LedgerEntry['state'], ...(args[5] ? { reason: args[5] as string } : {}) } : e));
      },
    },
  };
  const shell = { reap: async () => { if (o.route === 'none') throw new Error('m1 is not dialled in'); return { kept: [] }; } };
  const c = {
    store, clock: { now: () => new Date('2026-10-22T01:00:00Z') }, keepPanes: false, stopping: () => false, trigger: () => {},
    executors: { get: () => ({ cleanup: async () => { if (o.route !== 'own') throw new Error('herdr: not reached'); return { kept: [] }; }, machineShell: () => shell }) },
    machines: { list: async () => [{ id: 'm1', online: true, executors: ['herdr'] }] },
  };
  return { cleanups: createCleanups(c as never), closes, entries: () => entries };
}

describe('the cleanup closes the job\'s herdr pane entries', () => {
  it('reaped when the job\'s own executor closed the pane', async () => {
    const t = setup({ route: 'own' });
    await t.cleanups.run('j');
    expect(t.entries().map((e) => [e.kind, e.state, e.reason])).toEqual([['herdr_pane', 'reaped', undefined]]);
  });

  it('failed, with why, when only the machine was reached: the reap closes no pane', async () => {
    const t = setup({ route: 'machine' });
    await t.cleanups.run('j');
    expect(t.entries().map((e) => [e.kind, e.state, e.reason])).toEqual([['herdr_pane', 'failed', PANE_NOT_REACHED]]);
  });

  it('left live while the cleanup is deferred, and reaped when a person marks it cleaned up by hand', async () => {
    const t = setup({ route: 'none', deferred: true });
    await t.cleanups.resume();
    expect(t.entries().map((e) => e.state)).toEqual(['live']);
    t.cleanups.markCleanedUp('j');
    expect(t.entries().map((e) => [e.kind, e.state, e.reason])).toEqual([['herdr_pane', 'reaped', PANE_CLOSED_BY_HAND]]);
  });
});
