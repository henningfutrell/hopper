// The cleanup at a job's end and the retention per job status (issue #2494, design.md "The reap"): with a retention above
// 0 set for the status the job ended in, on its machine, the reap keeps its scratch dir, as a timed-out job's; the sweep
// removes it once the retention is over. With none, the reap removes it as before.
import { describe, expect, it } from 'vitest';
import { createCleanups } from '../../src/engine/cleanup.ts';
import type { Reaped } from '../../src/domain/ports.ts';

function setup(o: { status?: string; retainHours?: Record<string, number>; route?: 'own' | 'machine'; machinesFail?: boolean } = {}) {
  const job = {
    id: 'j', status: o.status ?? 'failed', spec: { executor: 'herdr' }, executorState: { cwd: '/w', laneId: 'm1/lane-1' },
  };
  const asked: unknown[] = [];
  const reaps: unknown[][] = [];
  const shell = { reap: async (...args: unknown[]): Promise<Reaped> => { reaps.push(args); return { kept: [] }; } };
  const cleanup = async (_job: unknown, opts?: unknown): Promise<Reaped> => {
    asked.push(opts);
    if (o.route === 'machine') throw new Error('ssh: Could not resolve hostname old-name');
    return { kept: [] };
  };
  const machine = { id: 'm1', online: true, executors: ['herdr'], ...(o.retainHours ? { sweep: { retainHours: o.retainHours } } : {}) };
  const c = {
    store: {
      jobs: { list: () => [job], get: () => job, update: () => job },
      events: { append: () => {}, recent: () => [] },
      tx: <T>(f: () => T): T => f(),
    },
    clock: { now: () => new Date('2026-10-22T00:00:00Z') }, keepPanes: false, stopping: () => false, trigger: () => {},
    executors: { get: () => ({ cleanup, machineShell: () => shell }) },
    machines: { list: async () => { if (o.machinesFail) throw new Error('down'); return [machine]; } },
  };
  return { cleanups: createCleanups(c as never), asked, reaps };
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
});
