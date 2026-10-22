// A job's cleanup that its own route cannot do (issue #2490): its executor state names an ssh destination that no longer
// resolves (the machine dials in now). The cleanup reaps through the machine as it is reached now, as the sweep reaches
// it, and is not deferred for ever.
import { describe, expect, it } from 'vitest';
import { createCleanups } from '../../src/engine/cleanup.ts';
import type { Reaped } from '../../src/domain/ports.ts';

const SSH_ERROR = 'the reap on m1 did not finish (exit 255): ssh: Could not resolve hostname old-name';

function setup(o: { deferred?: boolean; reachable?: boolean; kept?: string[] } = {}) {
  let job: Record<string, unknown> = {
    id: 'j', status: 'finished', spec: { executor: 'herdr' }, source: { key: 'gh:o/r#1' },
    executorState: { cwd: '/w', laneId: 'm1/lane-1', ssh: 'old-name' },
    ...(o.deferred ? { cleanupDeferred: { at: '2026-10-20T00:00:00.000Z', error: SSH_ERROR } } : {}),
  };
  const events: { type: string; data?: unknown }[] = [];
  const reaps: unknown[][] = [];
  const shell = {
    reap: async (...args: unknown[]): Promise<Reaped> => {
      reaps.push(args);
      if (o.reachable === false) throw new Error('m1 is not dialled in');
      return { kept: o.kept ?? [] };
    },
  };
  const store = {
    jobs: {
      list: () => [job],
      get: () => job,
      update: (_id: string, patch: Record<string, unknown>) => { job = { ...job, ...patch }; return job; },
    },
    events: { append: (e: { type: string; data?: unknown }) => { events.push(e); }, recent: () => [] },
    tx: <T>(f: () => T): T => f(),
  };
  const c = {
    store, clock: { now: () => new Date('2026-10-22T00:00:00Z') }, keepPanes: false, stopping: () => false, trigger: () => {},
    executors: { get: () => ({ cleanup: async () => { throw new Error(SSH_ERROR); }, machineShell: () => shell }) },
    machines: { list: async () => [{ id: 'm1', online: true, executors: ['herdr'] }] },
  };
  return { cleanups: createCleanups(c as never), job: () => job, events, reaps };
}

describe('a cleanup its own route cannot do', () => {
  it('reaps the job\'s scratch dir through the machine as it is reached now, and is not deferred', async () => {
    const t = setup();
    await t.cleanups.run('j');
    expect(t.reaps).toEqual([['j', '/w/.worktrees/@scratch/j', false]]);
    expect(t.job().cleanupDeferred).toBeUndefined();
    expect(t.events.map((e) => e.type)).not.toContain('job.cleanup_deferred');
  });

  it('a cleanup deferred before goes through at its retry, and is said so', async () => {
    const t = setup({ deferred: true });
    await t.cleanups.resume();
    expect(t.job().cleanupDeferred).toBeUndefined();
    expect(t.events).toContainEqual({ type: 'job.cleaned_up', jobId: 'j', data: { deferredAt: '2026-10-20T00:00:00.000Z' } });
  });

  it('what that reap kept is flagged on the job', async () => {
    const t = setup({ kept: ['/w/.worktrees/@scratch/j/repo'] });
    await t.cleanups.run('j');
    expect(t.events).toContainEqual({ type: 'job.work_kept', jobId: 'j', data: { paths: ['/w/.worktrees/@scratch/j/repo'] } });
  });

  it('stays deferred, with its own route\'s error, when the machine is not reached that way either', async () => {
    const t = setup({ reachable: false });
    await t.cleanups.run('j');
    expect(t.job().cleanupDeferred).toEqual({ at: '2026-10-22T00:00:00.000Z', error: SSH_ERROR });
    expect(t.cleanups.due()).toEqual([{ jobId: 'j', sourceKey: 'gh:o/r#1', error: SSH_ERROR }]);
  });
});
