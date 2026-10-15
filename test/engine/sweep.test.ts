// The sweep (issue #410): what it reaps of what jobs left on a machine, and when. The plan is pure; the
// runner is driven with a fake machine shell, the store's jobs and work trail as plain lists.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { planSweep } from '../../src/engine/sweep.ts';
import { HOUR, job, none, rig } from './sweep-rig.ts';

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

  it('a parked job (issue #501): what still runs of it is stopped, its scratch dir — its worktree — is never removed, whatever its age', () => {
    const parked = new Map([['park', job('park', 'parked')]]);
    const scratch = [{ jobId: 'park', path: '/w/.hopper-scratch/park', ageMs: 999 * HOUR }];
    expect(planSweep({ ...none, scopes: ['park'], scratch }, (id) => parked.get(id), new Set(['park']), 24 * HOUR)).toEqual([{ jobId: 'park' }]);
    expect(planSweep({ ...none, scratch }, (id) => parked.get(id), new Set(), 24 * HOUR)).toEqual([]);
  });

  it('a job worktree in the workspace (issue #1103): its ended job is reaped by its scratch dir, even once that is gone; never a job it does not know', () => {
    const trees = [
      { path: '/w/workspace/worktrees/my-app-done', ageMs: 25 * HOUR },
      { path: '/w/workspace/worktrees/app-run', ageMs: 99 * HOUR },
      { path: '/w/workspace/worktrees/app-stranger', ageMs: 99 * HOUR },
      { path: '/w/workspace/worktrees/app-fail', ageMs: 1 * HOUR },
      { path: '/w/workspace/worktrees/app-gone', ageMs: 1 * HOUR },
    ];
    expect(plan({ trees }, ['gone'])).toEqual([
      { jobId: 'done', scratch: '/w/.hopper-scratch/done' },
      { jobId: 'gone', scratch: '/w/.hopper-scratch/gone' },
    ]);
  });

  it('a job with a container or a volume left (issue #1120): reaped once it ended, whatever its age; never a parked or live job\'s, never a job it does not know', () => {
    const parked = new Map([...jobs, ['park', job('park', 'parked')]]);
    expect(planSweep({ ...none, containers: ['done', 'gone', 'run', 'queued', 'park', 'stranger'] }, (id) => parked.get(id), new Set(), 24 * HOUR))
      .toEqual([{ jobId: 'done' }, { jobId: 'gone' }]);
    expect(plan({ containers: ['done'], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 30 * HOUR }] }))
      .toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done' }]);
  });

  it('one reap per job: its processes and its scratch dir together', () => {
    expect(plan({ processes: ['done'], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 30 * HOUR }] }))
      .toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done' }]);
  });
});


describe('the sweep runner (issue #410)', () => {
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

  it('logs work it keeps only the first time (issue #1010): kept again on each pass is no news', async () => {
    const again = rig({ found: { scopes: [], processes: [], scratch: [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] }, kept: ['old'], keeps: ['old'] });
    await again.sweep.run(true);
    expect(again.logs).toEqual([]);
    const first = rig({ found: { scopes: [], processes: [], scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 30 * HOUR }] }, keeps: ['done'] });
    await first.sweep.run(true);
    expect(first.logs).toEqual([expect.stringContaining('kept: it holds work not pushed')]);
  });
});

describe('kept work of a done item (issue #1105)', () => {
  const found = { scopes: [], processes: [], scratch: [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] };

  it('is discarded by the sweep, whatever it holds: its item is done, so nobody waits on it', async () => {
    const r = rig({ found, kept: ['old'], keeps: ['old'], itemDone: ['old'] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'old', scratch: '/w/.hopper-scratch/old', discard: true }]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.hopper-scratch/old'], discarded: true, reason: 'merged' } });
    expect(r.logs).toEqual([expect.stringContaining('its item is done')]);
  });

  it('is kept while its item is not done; a machine that still kept it records nothing', async () => {
    const open = rig({ found, kept: ['old'], keeps: ['old'] });
    await open.sweep.run(true);
    expect(open.reaps).toEqual([{ jobId: 'old', scratch: '/w/.hopper-scratch/old' }]);
    expect(open.events).toHaveLength(1);
    const old = rig({ found, kept: ['old'], keeps: ['old'], itemDone: ['old'], oldClient: true });
    await old.sweep.run(true);
    expect(old.events).toHaveLength(1);
  });
});

describe('kept work nobody waits on (issue #1187)', () => {
  const found = { scopes: [], processes: [], scratch: [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] };
  it('a newer job of its item finished with nothing kept: discarded, superseded', async () => {
    const r = rig({ found, kept: ['old'], keeps: ['old'], others: [{ ...job('new', 'finished'), source: { source: 's', kind: 'github', key: 'item:old' } } as Job] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'old', scratch: '/w/.hopper-scratch/old', discard: true }]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.hopper-scratch/old'], discarded: true, reason: 'superseded' } });
  });

  it('a finished proposal job: discarded, as it never had work to push; a failed one is kept', async () => {
    const at = { ...none, scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: HOUR }, { jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }] };
    const r = rig({ found: at, kept: ['done', 'old'], keeps: ['done', 'old'], spec: { proposal: true } });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done', discard: true }, { jobId: 'old', scratch: '/w/.hopper-scratch/old' }]);
    expect(r.events.slice(2)).toEqual([{ type: 'job.work_removed', jobId: 'done', data: { paths: ['/w/.hopper-scratch/done'], discarded: true, reason: 'proposal' } }]);
  });
});

describe('kept work whose folder is gone (issue #1120)', () => {
  const at = (roots: string[], scratch: Survey['scratch'] = [], trees: Survey['trees'] = []): Survey => ({ ...none, scratch, trees, roots });

  it('is resolved: its scratch dir and its job worktree are missing from a work tree the survey found, so job.work_removed with gone', async () => {
    const r = rig({ found: at(['/w']), kept: ['old'] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.hopper-scratch/old'], gone: true } });
    expect(r.logs).toEqual([expect.stringContaining('job old\'s kept work is gone from m')]);
  });

  it('stays while its scratch dir or its job worktree is there', async () => {
    const dir = rig({ found: at(['/w'], [{ jobId: 'old', path: '/w/.hopper-scratch/old', ageMs: HOUR }]), kept: ['old'], keeps: ['old'] });
    await dir.sweep.run(true);
    expect(dir.events).toHaveLength(1);
    const tree = rig({ found: at(['/w'], [], [{ path: '/w/workspace/worktrees/app-old', ageMs: HOUR }]), kept: ['old'], keeps: ['old'] });
    await tree.sweep.run(true);
    expect(tree.events.filter((e) => (e.data as { gone?: boolean }).gone)).toEqual([]);
  });

  it('stays when the survey did not find its work tree (not there now, or a client older than this), or the job ran on another machine, or has not ended', async () => {
    const elsewhere = rig({ found: at(['/v']), kept: ['old'] });
    await elsewhere.sweep.run(true);
    const older = rig({ found: none, kept: ['old'] });
    await older.sweep.run(true);
    const other = rig({ found: at(['/w']), kept: ['old'], machines: [{ id: 'n', label: 'n', maxLanes: 1, online: true, executors: ['x'] }] });
    await other.sweep.run(true);
    const running = rig({ found: at(['/v']), kept: ['run'] });
    await running.sweep.run(true);
    expect([elsewhere, older, other, running].map((x) => x.events.length)).toEqual([1, 1, 1, 1]);
  });
});

describe('the hopper\'s own disk use (issue #1120)', () => {
  const GIB = 1024 ** 3;
  const places = (scratch: number, trees: number) => [{ path: '/w/.hopper-scratch', bytes: scratch * GIB }, { path: '/w/workspace/worktrees', bytes: trees * GIB }];
  // `done` ended an hour ago: not yet old enough for its scratch dir to go by age.
  const young: Survey = { ...none, scratch: [{ jobId: 'done', path: '/w/.hopper-scratch/done', ageMs: 1 * HOUR }], roots: ['/w'] };
  const disk = (r: ReturnType<typeof rig>) => r.events.filter((e) => e.type.startsWith('machine.disk_'));

  it('keeps each machine\'s last measure: each place, their sum and when; no budget, no alert and nothing reaped before its age', async () => {
    const r = rig({ found: { ...young, usage: places(3, 2) } });
    await r.sweep.run(true);
    expect(r.sweep.disk('m')).toEqual({ bytes: 5 * GIB, at: '2026-10-08T00:00:00.000Z', paths: places(3, 2), over: false });
    expect(r.reaps).toEqual([]);
    expect(disk(r)).toEqual([]);
  });

  it('a survey that measured nothing (a client older than this) leaves no measure', async () => {
    const r = rig({ found: young });
    await r.sweep.run(true);
    expect(r.sweep.disk('m')).toBeUndefined();
  });

  it('over its budget, the sweep reaps every ended job\'s scratch dir now, whatever its age, and measures again: back under, nobody is told', async () => {
    const r = rig({ budget: 4 * GIB, surveys: [{ ...young, usage: places(3, 2) }, { ...none, roots: ['/w'], usage: places(1, 2) }] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done', scratch: '/w/.hopper-scratch/done' }]);
    expect(r.surveyed).toHaveLength(2);
    expect(r.sweep.disk('m')).toMatchObject({ bytes: 3 * GIB, budgetBytes: 4 * GIB, over: false });
    expect(disk(r)).toEqual([]);
    expect(r.logs.some((l) => /over its disk budget/.test(l))).toBe(true);
  });

  it('still over once reaped: machine.disk_over_budget, once while it stays over; machine.disk_within_budget once it is back under', async () => {
    const r = rig({ budget: 4 * GIB, found: { ...young, usage: places(3, 2) } });
    await r.sweep.run(true);
    expect(disk(r)).toEqual([{ type: 'machine.disk_over_budget', machineId: 'm', data: { machineId: 'm', usedBytes: 5 * GIB, budgetBytes: 4 * GIB, paths: places(3, 2) } }]);
    expect(r.sweep.disk('m')).toMatchObject({ over: true });
    r.advance(10 * 60_000);
    await r.sweep.run();
    expect(disk(r)).toHaveLength(1);
    r.setBudget(10 * GIB);
    expect(r.sweep.disk('m')).toMatchObject({ budgetBytes: 10 * GIB, over: false });
    r.advance(10 * 60_000);
    await r.sweep.run();
    expect(disk(r).slice(1)).toEqual([{ type: 'machine.disk_within_budget', machineId: 'm', data: { machineId: 'm', usedBytes: 5 * GIB, budgetBytes: 10 * GIB } }]);
  });

  it('the budget turned off while over: nobody is told, and nothing is reaped before its age', async () => {
    const r = rig({ budget: 4 * GIB, found: { ...young, usage: places(3, 2) } });
    await r.sweep.run(true);
    r.setBudget(undefined);
    r.advance(10 * 60_000);
    const reaps = r.reaps.length;
    await r.sweep.run();
    expect(disk(r)).toHaveLength(1);
    expect(r.reaps).toHaveLength(reaps);
    expect(r.sweep.disk('m')).toEqual({ bytes: 5 * GIB, at: '2026-10-08T00:10:00.000Z', paths: places(3, 2), over: false });
  });
});

describe('a job\'s containers and volumes (issue #1120)', () => {
  it('the sweep reaps an ended job that still has one, and records what its reap removed: job.containers_removed', async () => {
    const r = rig({ found: { ...none, containers: ['done', 'run'] }, containers: ['done'] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'done' }]);
    expect(r.events).toEqual([{ type: 'job.containers_removed', jobId: 'done', machineId: 'm', data: { containers: ['c-done'], volumes: ['v-done'] } }]);
    expect(r.logs).toContainEqual(expect.stringContaining('removed 1 container and 1 volume of job done on m'));
  });

  it('a reap that removed none records nothing', async () => {
    const r = rig({ found: { ...none, containers: ['done'] } });
    await r.sweep.run(true);
    expect(r.events).toEqual([]);
  });

  it('a discard records what its reap removed too', async () => {
    const r = rig({ kept: ['old'], containers: ['old'] });
    r.events[0]!.data = { paths: ['/w/.hopper-scratch/old/repo'] };
    await r.sweep.discard('old', { person: 'Pat', via: 'ui' });
    expect(r.events.filter((e) => e.type === 'job.containers_removed')).toEqual([{ type: 'job.containers_removed', jobId: 'old', machineId: 'm', data: { containers: ['c-old'], volumes: ['v-old'] } }]);
  });
});

describe('discarding kept work (issue #1010)', () => {
  const by = { person: 'Pat', via: 'ui' as const };

  it('reaps the job\'s scratch dir on its machine whatever it holds, and records job.work_removed, discarded, with who', async () => {
    const r = rig({ kept: ['old'] });
    r.events[0]!.data = { paths: ['/w/.hopper-scratch/old/repo'] };
    expect(await r.sweep.discard('old', by)).toEqual({ jobId: 'old', paths: ['/w/.hopper-scratch/old'] });
    expect(r.reaps).toEqual([{ jobId: 'old', scratch: '/w/.hopper-scratch/old', discard: true }]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.hopper-scratch/old'], discarded: true, person: 'Pat', via: 'ui' } });
  });

  it('refuses a job with no work kept, one that runs, and one whose machine is offline; reaps nothing', async () => {
    const none = rig();
    await expect(none.sweep.discard('old', by)).rejects.toThrow('job old has no work kept');
    await expect(none.sweep.discard('nope', by)).rejects.toThrow('job nope not found');
    const running = rig({ kept: ['run'] });
    await expect(running.sweep.discard('run', by)).rejects.toThrow('job run is running: only an ended job\'s work is discarded');
    const off = rig({ kept: ['old'], machines: [{ id: 'm', label: 'm', maxLanes: 1, online: false, executors: ['x'] }] });
    await expect(off.sweep.discard('old', by)).rejects.toThrow('its machine m is offline');
    expect([...none.reaps, ...running.reaps, ...off.reaps]).toEqual([]);
  });

  it('a machine that still kept it (a client older than the discard) is said, and nothing is recorded', async () => {
    const r = rig({ kept: ['old'], keeps: ['old'], oldClient: true });
    r.events[0]!.data = { paths: ['/w/.hopper-scratch/old/repo'] };
    await expect(r.sweep.discard('old', by)).rejects.toThrow('the machine m kept it: update its client, then discard it again');
    expect(r.events).toHaveLength(1);
  });
});
