// The cleanup at a job's end and the retention per job status (issue #2494, design.md "The reap"): with a retention above
// 0 set for the status the job ended in, on its machine, the reap keeps its scratch dir, as a timed-out job's; the sweep
// removes it once the retention is over. With none, the reap removes it as before.
import { describe, expect, it } from 'vitest';
import { createCleanups } from '../../src/engine/cleanup.ts';
import type { Reaped } from '../../src/domain/ports.ts';
import type { LedgerEntry } from '../../src/domain/resource-ledger.ts';

function setup(o: { status?: string; retainHours?: Record<string, number>; dryRun?: boolean; route?: 'own' | 'machine'; machinesFail?: boolean } = {}) {
  const job = {
    id: 'j', status: o.status ?? 'failed', spec: { executor: 'herdr' }, executorState: { cwd: '/w', laneId: 'm1/lane-1' }, finishedAt: '2026-10-21T23:00:00.000Z',
  };
  // The job's resource ledger (issue #2504 part 5): its scratch dir and its scope.
  const ledger: LedgerEntry[] = [
    { jobId: 'j', machineId: 'm1', kind: 'scratch_dir', locator: '/w/.worktrees/@scratch/j', createdAt: '2026-10-21T22:00:00.000Z', state: 'live' },
    { jobId: 'j', machineId: 'm1', kind: 'job_scope', locator: 'hopper-job-j.scope', createdAt: '2026-10-21T22:00:00.000Z', state: 'live' },
  ];
  const resourceLedger = {
    forJob: () => ledger, open: () => ledger.filter((e) => e.state === 'live' || e.state === 'failed'),
    close: (_j: string, kind: string, locator: string, state: LedgerEntry['state'], at: string) => { Object.assign(ledger.find((e) => e.kind === kind && e.locator === locator)!, { state, endedAt: at }); },
    retain: (_j: string, kind: string, locator: string, until: string) => { Object.assign(ledger.find((e) => e.kind === kind && e.locator === locator)!, { retainedUntil: until }); },
  };
  const asked: unknown[] = [];
  const reaps: unknown[][] = [];
  const shell = { reap: async (...args: unknown[]): Promise<Reaped> => { reaps.push(args); return { kept: [] }; } };
  const cleanup = async (_job: unknown, opts?: unknown): Promise<Reaped> => {
    asked.push(opts);
    if (o.route === 'machine') throw new Error('ssh: Could not resolve hostname old-name');
    return { kept: [] };
  };
  const machine = { id: 'm1', online: true, executors: ['herdr'], ...(o.retainHours || o.dryRun ? { sweep: { ...(o.retainHours ? { retainHours: o.retainHours } : {}), ...(o.dryRun ? { dryRun: true } : {}) } } : {}) };
  const c = {
    store: {
      jobs: { list: () => [job], get: () => job, update: () => job }, resourceLedger,
      events: { append: () => {}, recent: () => [] },
      tx: <T>(f: () => T): T => f(),
    },
    clock: { now: () => new Date('2026-10-22T00:00:00Z') }, keepPanes: false, stopping: () => false, trigger: () => {},
    executors: { get: () => ({ cleanup, machineShell: () => shell }) },
    machines: { list: async () => { if (o.machinesFail) throw new Error('down'); return [machine]; } },
  };
  return { cleanups: createCleanups(c as never), asked, reaps, ledger };
}

describe('the cleanup at a job\'s end and the retention per job status (issue #2494)', () => {
  it('a retention set for the status: the executor\'s reap keeps the scratch dir', async () => {
    const t = setup({ retainHours: { failed: 24 } });
    await t.cleanups.run('j');
    expect(t.asked).toEqual([{ keepScratch: true }]);
  });

  it('none set, set for another status, or set to 0: the reap removes it as before', async () => {
    for (const retainHours of [undefined, { finished: 24 }, { failed: 0 }] as (Record<string, number> | undefined)[]) {
      const t = setup(retainHours ? { retainHours } : {});
      await t.cleanups.run('j');
      expect(t.asked).toEqual([{ keepScratch: false }]);
    }
  });

  it('a machine in dry run (issue #2494 part 14): the reap keeps the scratch dir, so the sweep lists it', async () => {
    const t = setup({ dryRun: true });
    await t.cleanups.run('j');
    expect(t.asked).toEqual([{ keepScratch: true }]);
  });

  it('the machines cannot be read: the reap removes it as before', async () => {
    const t = setup({ retainHours: { failed: 24 }, machinesFail: true });
    await t.cleanups.run('j');
    expect(t.asked).toEqual([{ keepScratch: false }]);
  });

  it('through the machine as it is reached now, the reap keeps it too', async () => {
    const t = setup({ retainHours: { failed: 24 }, route: 'machine' });
    await t.cleanups.run('j');
    expect(t.reaps).toEqual([['j', '/w/.worktrees/@scratch/j', true]]);
  });

  it('keeps the scratch dir\'s ledger entry open until the retention ends, and closes the scope (issue #2504 part 5)', async () => {
    const t = setup({ retainHours: { failed: 24 } });
    await t.cleanups.run('j');
    expect(t.ledger.map((e) => [e.kind, e.state, e.retainedUntil])).toEqual([['scratch_dir', 'live', '2026-10-22T23:00:00.000Z'], ['job_scope', 'reaped', undefined]]);
  });

  it('with no retention, the reap closes every entry as before', async () => {
    const t = setup();
    await t.cleanups.run('j');
    expect(t.ledger.map((e) => [e.kind, e.state, e.retainedUntil])).toEqual([['scratch_dir', 'reaped', undefined], ['job_scope', 'reaped', undefined]]);
  });
});
