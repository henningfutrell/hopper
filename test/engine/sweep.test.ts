// The sweep (issue #410): what it reaps of what jobs left on a machine, and when. The plan is pure; the
// runner is driven with a fake machine shell, the store's jobs and work trail as plain lists.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job, MachineSnapshot } from '../../src/domain/types.ts';
import type { Executor, MachineShell, Survey } from '../../src/domain/ports.ts';
import { createSweep, planSweep } from '../../src/engine/sweep.ts';

const HOUR = 3600_000;
const job = (id: string, status: Job['status'], cwd = '/w'): Job => ({
  id, spec: { executor: 'x', payload: {} }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1, executorState: { cwd },
});
const none: Survey = { scopes: [], processes: [], scratch: [] };

describe('what the sweep reaps (issue #410)', () => {
  const jobs = new Map([
    ['run', job('run', 'running')], ['wait', job('wait', 'waiting_answer')], ['claim', job('claim', 'claimed')], ['op', job('op', 'operator_led')],
    ['done', job('done', 'finished')], ['fail', job('fail', 'failed')], ['gone', job('gone', 'cancelled')], ['queued', job('queued', 'queued')],
  ]);
  const plan = (found: Partial<Survey>, kept: string[] = []) => planSweep({ ...none, ...found }, (id) => jobs.get(id), new Set(kept), 24 * HOUR);

  it('stops the scope and processes of a job that is not live; never a live job\'s, never a job it does not know', () => {
    expect(plan({ scopes: ['done', 'run', 'stranger'], processes: ['fail', 'wait', 'claim', 'op', 'queued', 'other-hopper'] }))
      .toEqual([{ jobId: 'done' }, { jobId: 'fail' }, { jobId: 'queued' }]);
  });

  it('removes an ended job\'s scratch dir once it is old enough, or at once while its work was kept', () => {
    const scratch = [
      { jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 25 * HOUR },
      { jobId: 'fail', path: '/w/.hopper-scratch/fail', ageMs: 1 * HOUR },
      { jobId: 'gone', path: '/w/.hopper-scratch/gone', ageMs: 1 * HOUR },
      { jobId: 'run', path: '/w/.hopper-scratch/run', ageMs: 99 * HOUR },
      { jobId: 'queued', path: '/w/.hopper-scratch/queued', ageMs: 99 * HOUR },
      { jobId: 'stranger', path: '/w/.hopper-scratch/stranger', ageMs: 99 * HOUR },
    ];
    expect(plan({ scratch }, ['gone'])).toEqual([
      { jobId: 'done', scratch: '/w/.hopper-scratch/done' },
      { jobId: 'gone', scratch: '/w/.hopper-scratch/gone' },
    ]);
  });

  it('one reap per job: its processes and its scratch dir together', () => {
    expect(plan({ processes: ['done'], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 30 * HOUR }] }))
      .toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done' }]);
  });
});

describe('the sweep runner (issue #410)', () => {
  function rig(o: { found?: Survey; kept?: string[]; machines?: MachineSnapshot[]; keeps?: string[] } = {}) {
    let now = Date.parse('2026-10-08T00:00:00Z');
    const jobs = [job('done', 'finished', '/w'), job('run', 'running', '/v'), job('old', 'failed', '/w')];
    const events: { type: string; jobId?: string; data: unknown }[] = (o.kept ?? []).map((id) => ({ type: 'job.work_kept', jobId: id, data: { paths: ['x'] } }));
    const surveyed: string[][] = [];
    const reaps: { jobId: string; scratch?: string }[] = [];
    const shell: MachineShell = {
      async survey(roots) { surveyed.push(roots); return o.found ?? none; },
      async reap(jobId, scratch) { reaps.push({ jobId, ...(scratch ? { scratch } : {}) }); return { kept: scratch && o.keeps?.includes(jobId) ? [`${scratch}/repo`] : [] }; },
    };
    const executor = { name: 'x', validate: () => null, run: async () => ({ kind: 'failed' as const, error: '' }), machineShell: (m: MachineSnapshot) => (m.id === 'unreachable' ? undefined : shell) } satisfies Executor;
    const machines = o.machines ?? [{ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'] }];
    const sweep = createSweep({
      clock: { now: () => new Date(now) },
      stopping: () => false,
      machines: { list: async () => machines },
      executors: { get: (n: string) => (n === 'x' ? executor : undefined), names: () => ['x'] } as never,
      store: {
        jobs: { list: () => jobs, get: (id: string) => jobs.find((j) => j.id === id) },
        events: {
          recent: (_limit: number, types: string[]) => events.filter((e) => types.includes(e.type)).reverse() as unknown as DomainEvent[],
          append: (e: { type: string; jobId?: string; data: unknown }) => { events.push(e); return e as unknown as DomainEvent; },
        },
      } as never,
    }, () => {});
    return { sweep, surveyed, reaps, events, advance: (ms: number) => { now += ms; } };
  }

  it('asks each online machine about the work trees of the jobs it knows, then reaps what the plan says', async () => {
    const r = rig({ found: { scopes: [], processes: ['done', 'run'], scratch: [] } });
    await r.sweep.run(true);
    expect(r.surveyed).toEqual([['/v', '/w']]);
    expect(r.reaps).toEqual([{ jobId: 'done' }]);
  });

  it('sweeps a machine again only once its interval has passed: 10 minutes, or its own setting', async () => {
    const r = rig({ machines: [
      { id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'] },
      { id: 'quick', label: 'q', maxLanes: 1, online: true, executors: ['x'], sweep: { everyMinutes: 2 } },
    ] });
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(2);
    r.advance(3 * 60_000);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(3);
    r.advance(8 * 60_000);
    await r.sweep.run();
    expect(r.surveyed).toHaveLength(5);
  });

  it('skips a machine that is offline, a container target, or one no executor reaches', async () => {
    const r = rig({ machines: [
      { id: 'off', label: 'o', maxLanes: 1, online: false, executors: ['x'] },
      { id: 'box', label: 'b', maxLanes: 1, online: true, executors: ['x'], docker: 'c' },
      { id: 'unreachable', label: 'u', maxLanes: 1, online: true, executors: ['x'] },
    ] });
    await r.sweep.run(true);
    expect(r.surveyed).toEqual([]);
  });

  it('a machine\'s own scratch age: an ended job\'s dir is removed once that old', async () => {
    const found = { scopes: [], processes: [], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 2 * HOUR }] };
    const young = rig({ found });
    await young.sweep.run(true);
    expect(young.reaps).toEqual([]);
    const r = rig({ found, machines: [{ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'], sweep: { scratchMaxAgeHours: 1 } }] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done' }]);
  });

  it('kept work is tried again on each pass; removed once pushed, it is recorded as job.work_removed', async () => {
    const found = { scopes: [], processes: [], scratch: [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] };
    const r = rig({ found, kept: ['old'] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'old', scratch: '/w/.hopper-scratch/old' }]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.hopper-scratch/old'] } });
  });

  it('kept again records nothing new; kept the first time by the sweep is recorded as job.work_kept', async () => {
    const again = rig({ found: { scopes: [], processes: [], scratch: [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] }, kept: ['old'], keeps: ['old'] });
    await again.sweep.run(true);
    expect(again.events).toHaveLength(1);
    const first = rig({ found: { scopes: [], processes: [], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 30 * HOUR }] }, keeps: ['done'] });
    await first.sweep.run(true);
    expect(first.events).toEqual([{ type: 'job.work_kept', jobId: 'done', data: { paths: ['/w/.hopper-scratch/done/repo'] } }]);
  });
});
