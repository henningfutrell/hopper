// The leftover check (issue #2504): an ended job whose resource ledger still holds an entry live or failed after the grace
// period is recorded once as job.cleanup_leftover — not again at the next pass, nor after a restart — and never ignored.
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../src/domain/resource-ledger.ts';
import type { Job } from '../../src/domain/types.ts';
import { createLeftoverCheck } from '../../src/engine/cleanup-leftovers.ts';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const entry = (jobId: string, state: LedgerEntry['state'], reason?: string): LedgerEntry =>
  ({ jobId, machineId: 'm1', kind: 'scratch_dir', locator: `/w/.worktrees/@scratch/${jobId}`, createdAt: ago(300), state, ...(reason ? { reason } : {}) });

function rig(ledger: LedgerEntry[], jobs: Partial<Job>[]) {
  const events: { type: string; jobId?: string; data: unknown }[] = [];
  const logs: string[] = [];
  const store = {
    resourceLedger: { open: () => ledger.filter((e) => e.state === 'live' || e.state === 'failed') },
    jobs: { get: (id: string) => jobs.find((j) => j.id === id) },
    events: {
      recent: (_n: number, types: string[], jobId?: string) => events.filter((e) => types.includes(e.type) && e.jobId === jobId),
      append: (e: { type: string; jobId?: string; data: unknown }) => { events.push(e); return e; },
    },
  };
  const check = () => createLeftoverCheck({ store: store as never, clock: { now: () => new Date(NOW) } }, (l) => logs.push(l));
  return { events, logs, check };
}

describe('the leftover check (issue #2504)', () => {
  const jobs: Partial<Job>[] = [
    { id: 'old', status: 'failed', finishedAt: ago(90), updatedAt: ago(90) },
    { id: 'new', status: 'finished', finishedAt: ago(5), updatedAt: ago(5) },
    { id: 'run', status: 'running', updatedAt: ago(500) },
    { id: 'clean', status: 'finished', finishedAt: ago(500), updatedAt: ago(500) },
  ];
  const ledger = [entry('old', 'failed', '/w/.worktrees/@scratch/old/containers is still there'), entry('new', 'live'), entry('run', 'live'), entry('clean', 'reaped')];

  it('records each leftover past the grace period once, with its entries', () => {
    const r = rig(ledger, jobs);
    const check = r.check();
    check();
    check();
    expect(r.events).toEqual([{
      type: 'job.cleanup_leftover', jobId: 'old',
      data: { endedAt: ago(90), graceMinutes: 60, entries: [{ machineId: 'm1', kind: 'scratch_dir', locator: '/w/.worktrees/@scratch/old', state: 'failed', reason: '/w/.worktrees/@scratch/old/containers is still there' }] },
    }]);
    expect(r.logs).toEqual([`hopper: job old ended at ${ago(90)} and its cleanup left /w/.worktrees/@scratch/old on m1 (failed)`]);
  });

  it('does not record it again after a restart', () => {
    const r = rig(ledger, jobs);
    r.check()();
    r.check()();
    expect(r.events.map((e) => e.jobId)).toEqual(['old']);
  });

  it('says a check that failed, and throws nothing', () => {
    const r = rig(ledger, jobs);
    const check = createLeftoverCheck({ store: { resourceLedger: { open: () => { throw new Error('no database'); } } } as never, clock: { now: () => new Date(NOW) } }, (l) => r.logs.push(l));
    expect(() => check()).not.toThrow();
    expect(r.logs).toEqual(['hopper: the leftover check failed: no database']);
  });
});
