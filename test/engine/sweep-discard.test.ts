// Discarding kept work (issues #1010, #1194): the sweep reaps the job's scratch dir on its machine whatever it holds,
// after the answer, and says how the removal goes. Driven with the sweep's rig: a fake machine shell, the store's jobs and
// work trail as plain lists.
import { describe, expect, it } from 'vitest';
import { rig } from './sweep-rig.ts';

describe('discarding kept work (issue #1010)', () => {
  const by = { person: 'Pat', via: 'ui' as const };

  it('reaps the job\'s scratch dir on its machine whatever it holds, and records job.work_removed, discarded, with who', async () => {
    const r = rig({ kept: ['old'] });
    r.events[0]!.data = { paths: ['/w/.worktrees/@scratch/old/repo'] };
    expect(await r.sweep.discard('old', by)).toEqual({ jobId: 'old', paths: ['/w/.worktrees/@scratch/old'] });
    await r.sweep.removals();
    expect(r.reaps).toEqual([{ jobId: 'old', scratch: '/w/.worktrees/@scratch/old', discard: true }]);
    expect(r.events.at(-1)).toEqual({ type: 'job.work_removed', jobId: 'old', data: { paths: ['/w/.worktrees/@scratch/old'], discarded: true, person: 'Pat', via: 'ui' } });
    expect(r.sweep.discarding('old')).toBeUndefined();
  });

  it('answers before the reap ends (issue #1194): removing meanwhile, and a second discard answers the same, with one reap', async () => {
    let release!: () => void;
    const r = rig({ kept: ['old'], reapGate: new Promise<void>((res) => { release = res; }) });
    expect(await r.sweep.discard('old', by)).toEqual({ jobId: 'old', paths: ['/w/.worktrees/@scratch/old'] });
    expect(r.sweep.discarding('old')).toEqual({ state: 'removing' });
    expect(r.events.map((e) => e.type)).toEqual(['job.work_kept']);
    expect(await r.sweep.discard('old', by)).toEqual({ jobId: 'old', paths: ['/w/.worktrees/@scratch/old'] });
    release();
    await r.sweep.removals();
    expect(r.reaps).toHaveLength(1);
    expect(r.events.map((e) => e.type)).toEqual(['job.work_kept', 'job.work_removed']);
    expect(r.sweep.discarding('old')).toBeUndefined();
  });

  it('a machine out of reach for the reap: failed, with why and who, the work still kept (issue #1194)', async () => {
    const r = rig({ kept: ['old'], reapFails: 'the machine m is out of reach' });
    await r.sweep.discard('old', by);
    await r.sweep.removals();
    expect(r.sweep.discarding('old')).toEqual({ state: 'failed', error: 'the machine m is out of reach' });
    expect(r.events.at(-1)).toEqual({ type: 'job.work_discard_failed', jobId: 'old', data: { error: 'the machine m is out of reach', person: 'Pat', via: 'ui' } });
    expect(r.events.some((e) => e.type === 'job.work_removed')).toBe(false);
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

  it('a machine that still kept it (a client older than the discard) is said, and no removal is recorded', async () => {
    const r = rig({ kept: ['old'], keeps: ['old'], oldClient: true });
    r.events[0]!.data = { paths: ['/w/.worktrees/@scratch/old/repo'] };
    await r.sweep.discard('old', by);
    await r.sweep.removals();
    const why = 'the machine m kept it: update its client, then discard it again';
    expect(r.sweep.discarding('old')).toEqual({ state: 'failed', error: why });
    expect(r.events.map((e) => e.type)).toEqual(['job.work_kept', 'job.work_discard_failed']);
    expect(r.events.at(-1)!.data).toEqual({ error: why, person: 'Pat', via: 'ui' });
  });

  // Issue #1570: the discard is a record on the job until its removal ends.
  it('a discard a stop cut short is done by the next sweep of its machine, before its reaps; one that failed is not', async () => {
    const r = rig({ kept: ['old', 'done'] });
    const scratch = '/w/.worktrees/@scratch/old';
    r.jobs[r.jobs.findIndex((j) => j.id === 'old')]!.discard = { at: '', scratch, by };
    r.jobs[r.jobs.findIndex((j) => j.id === 'done')]!.discard = { at: '', scratch: '/w/.worktrees/@scratch/done', by, error: 'the machine m is out of reach' };
    expect(r.sweep.discarding('old')).toEqual({ state: 'removing' });
    await r.sweep.run(true);
    expect(r.reaps.filter((x) => x.discard)).toEqual([{ jobId: 'old', scratch, discard: true }]);
    expect(r.events.filter((e) => e.type === 'job.work_removed')).toEqual([{ type: 'job.work_removed', jobId: 'old', data: { paths: [scratch], discarded: true, person: 'Pat', via: 'ui' } }]);
    expect(r.jobs.find((j) => j.id === 'old')!.discard).toBeUndefined();
    expect(r.sweep.discarding('old')).toBeUndefined();
    expect(r.sweep.discarding('done')).toEqual({ state: 'failed', error: 'the machine m is out of reach' });
  });
});
