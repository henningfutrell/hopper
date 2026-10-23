// The maids (issue #2504 part 14): each ledger entry an ended job's cleanup left is reaped again through its machine's
// shell, after a backoff kept on the entry. A transport failure and a restart between attempts: the next pass, by a new
// hopper on the same database, goes on and completes, and a pass after that reaps nothing twice. Work not pushed is kept
// and flagged, never removed. Real database (tenant migration 98); the machine's shell is a fake.
import { describe, expect, it } from 'vitest';
import type { MachineShell, Reaped } from '../../src/domain/ports.ts';
import type { UserStore } from '../../src/domain/store.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createMaids } from '../../src/engine/maids.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const T0 = '2026-10-23T12:00:00.000Z';

/** A machine m1 whose shell reaps as `said` says, one call at a time; a call `said` throws in fails as a transport would. */
function rig(store: UserStore, clock: ReturnType<typeof fixedClock>, said: (call: number) => Reaped, machine: Partial<MachineSnapshot> = {}) {
  const reaps: [string, string | undefined][] = [];
  const shell = { reap: (jobId: string, scratch?: string) => { reaps.push([jobId, scratch]); return Promise.resolve().then(() => said(reaps.length)); } } as Partial<MachineShell> as MachineShell;
  const m = { id: 'm1', executors: ['x'], online: true, ...machine } as MachineSnapshot;
  const logs: string[] = [];
  const maids = createMaids({
    store, clock, stopping: () => false, machines: { list: () => Promise.resolve([m]) } as never,
    executors: new Map([['x', { machineShell: () => shell }]]) as never,
  }, (l) => logs.push(l));
  return { maids, reaps, logs };
}

/** An ended job on m1 whose cleanup left its scratch dir (failed) and its processes (live). */
function seeded(store: UserStore): string {
  const job = store.jobs.create(spec, 1);
  store.jobs.update(job.id, { status: 'failed', finishedAt: T0, error: 'broke' });
  const e = { jobId: job.id, machineId: 'm1', createdAt: T0 };
  store.resourceLedger.record({ ...e, kind: 'scratch_dir', locator: `/w/.worktrees/@scratch/${job.id}` });
  store.resourceLedger.record({ ...e, kind: 'job_worktree', locator: `/w/.worktrees/app/${job.id}` });
  store.resourceLedger.record({ ...e, kind: 'job_processes', locator: `HOPPER_JOB_ID=${job.id}` });
  store.resourceLedger.close(job.id, 'scratch_dir', `/w/.worktrees/@scratch/${job.id}`, 'failed', T0, `/w/.worktrees/@scratch/${job.id}/containers is still there`);
  store.resourceLedger.close(job.id, 'job_worktree', `/w/.worktrees/app/${job.id}`, 'reaped', T0);
  return job.id;
}

const rows = (store: UserStore, jobId: string) => store.resourceLedger.forJob(jobId).map((e) => [e.kind, e.state, e.attempts ?? 0, e.nextAttemptAt ?? null, e.reason ?? null]);

describe('the maids (issue #2504 part 14)', () => {
  it('a transport failure, then a restart: the next hopper tries again after the backoff and completes, and frees nothing twice', async () => {
    const url = t.url();
    const clock = fixedClock(T0);
    const first = t.open(url, clock);
    const jobId = seeded(first);
    const a = rig(first, clock, () => { throw new Error('ssh: connection refused'); });
    await a.maids();
    expect(a.reaps).toEqual([[jobId, `/w/.worktrees/@scratch/${jobId}`]]);
    const failed = 'the reap on m1 failed: ssh: connection refused', next = '2026-10-23T12:01:00.000Z';
    expect(rows(first, jobId)).toEqual([
      ['job_processes', 'failed', 1, next, failed],
      ['job_worktree', 'reaped', 0, null, null],
      ['scratch_dir', 'failed', 1, next, failed],
    ]);
    expect(a.logs).toEqual([`hopper: the maids could not reap job ${jobId} on m1: ssh: connection refused`]);
    // Not due before its backoff.
    await a.maids();
    expect(a.reaps).toHaveLength(1);
    first.close();

    clock.set(next);
    const second = t.open(url, clock);
    const b = rig(second, clock, () => ({ kept: [] }));
    await b.maids();
    expect(b.reaps).toEqual([[jobId, `/w/.worktrees/@scratch/${jobId}`]]);
    expect(rows(second, jobId).map(([kind, state, attempts]) => [kind, state, attempts])).toEqual([['job_processes', 'reaped', 1], ['job_worktree', 'reaped', 0], ['scratch_dir', 'reaped', 1]]);
    clock.set('2026-10-24T12:00:00.000Z');
    await b.maids();
    expect(b.reaps).toHaveLength(1);
    second.close();
  });

  it('an entry the reap still left is tried again with a longer wait; the parts list says so', async () => {
    const clock = fixedClock(T0);
    const store = t.open(t.url(), clock);
    const jobId = seeded(store);
    const left = `/w/.worktrees/@scratch/${jobId}/containers`;
    const r = rig(store, clock, () => ({ kept: [], left: [left] }));
    await r.maids();
    clock.set('2026-10-23T12:01:00.000Z');
    await r.maids();
    expect(r.reaps).toHaveLength(2);
    expect(rows(store, jobId).filter(([kind]) => kind !== 'job_worktree')).toEqual([
      ['job_processes', 'reaped', 0, null, null],
      ['scratch_dir', 'failed', 2, '2026-10-23T12:03:00.000Z', `${left} is still there`],
    ]);
    store.close();
  });

  it('keeps and flags work not pushed, and never tries it again', async () => {
    const clock = fixedClock(T0);
    const store = t.open(t.url(), clock);
    const jobId = seeded(store);
    const scratch = `/w/.worktrees/@scratch/${jobId}`;
    const r = rig(store, clock, () => ({ kept: [`${scratch}/app`], reasons: { [`${scratch}/app`]: ['unpushed'] } }));
    await r.maids();
    expect(rows(store, jobId).map(([kind, state]) => [kind, state])).toEqual([['job_processes', 'reaped'], ['job_worktree', 'reaped'], ['scratch_dir', 'kept']]);
    expect(store.events.recent(5, ['job.work_kept'], jobId).map((e) => e.data)).toEqual([{ paths: [`${scratch}/app`], reasons: { [`${scratch}/app`]: ['unpushed'] } }]);
    clock.set('2026-10-24T12:00:00.000Z');
    await r.maids();
    expect(r.reaps).toHaveLength(1);
    store.close();
  });

  it('counts an offline machine as an attempt, and reaps nothing on a machine on a dry run or of a job whose own cleanup is due', async () => {
    const clock = fixedClock(T0);
    const store = t.open(t.url(), clock);
    const jobId = seeded(store);
    const off = rig(store, clock, () => ({ kept: [] }), { online: false });
    await off.maids();
    expect(off.reaps).toEqual([]);
    expect(rows(store, jobId).find(([kind]) => kind === 'scratch_dir')).toEqual(['scratch_dir', 'failed', 1, '2026-10-23T12:01:00.000Z', 'its machine m1 is offline']);
    clock.set('2026-10-23T13:00:00.000Z');
    const dry = rig(store, clock, () => ({ kept: [] }), { sweep: { dryRun: true } as never });
    await dry.maids();
    expect(dry.reaps).toEqual([]);
    store.jobs.update(jobId, { cleanupDue: { at: T0 } });
    const owed = rig(store, clock, () => ({ kept: [] }));
    await owed.maids();
    expect(owed.reaps).toEqual([]);
    store.close();
  });
});
