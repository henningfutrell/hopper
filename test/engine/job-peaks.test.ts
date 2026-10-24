// Issue #2737: where no scope holds a job (no systemd user manager) or its scope ended before the reap, the reap reads no
// peak. The engine keeps the most memory each machine's meter said the job held, and the cleanup records it in
// job.resources_used in place of the reap's, so the job's expected peak has a history there too.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot, ResourceReading } from '../../src/domain/types.ts';
import { createCleanups } from '../../src/engine/cleanup.ts';
import { createJobPeaks } from '../../src/engine/job-peaks.ts';
import { machine } from '../decider/support.ts';

const GIB = 1024 ** 3;
const reading = (jobUse: ResourceReading['jobUse']): ResourceReading => ({ cores: 4, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB, ...(jobUse ? { jobUse } : {}) });

describe('the metered peaks', () => {
  it('keep the most memory any meter said the job held, also once the meter no longer names it', async () => {
    let readings: MachineSnapshot[] = [machine({ id: 'wsl', resources: reading({ a: { memoryPeakBytes: 2 * GIB }, b: { cpuSeconds: 3 } }) })];
    const peaks = createJobPeaks({ now: () => new Date(0) });
    const machines = peaks.source({ list: async () => readings });
    await machines.list();
    readings = [machine({ id: 'wsl', resources: reading({ a: { memoryPeakBytes: 3 * GIB } }) })];
    await machines.list();
    readings = [machine({ id: 'wsl', resources: reading({ a: { memoryPeakBytes: GIB } }) })];
    await machines.list();
    readings = [machine({ id: 'wsl', resources: reading(undefined) })];
    expect(await machines.list()).toBe(readings);
    expect(peaks.take('b')).toBeUndefined();
    expect(peaks.take('a')).toBe(3 * GIB);
    expect(peaks.take('a')).toBeUndefined();
  });

  it('forget a job the meter has not named for longer than they keep it', async () => {
    let now = 0;
    const peaks = createJobPeaks({ now: () => new Date(now) }, 1000);
    let readings: MachineSnapshot[] = [machine({ id: 'wsl', resources: reading({ a: { memoryPeakBytes: GIB } }) })];
    const machines = peaks.source({ list: async () => readings });
    await machines.list();
    readings = [machine({ id: 'wsl', resources: reading({ c: { memoryPeakBytes: GIB } }) })];
    now = 1001;
    await machines.list();
    expect(peaks.take('a')).toBeUndefined();
    expect(peaks.take('c')).toBe(GIB);
  });
});

function setup(used: object | undefined, metered: number | undefined) {
  const job = { id: 'j', status: 'finished', spec: { executor: 'agent' }, executorState: { cwd: '/w', laneId: 'wsl/lane-1' } };
  const events: Array<{ type: string; data: unknown; machineId?: string }> = [];
  const store = {
    jobs: { list: () => [job], get: () => job, update: () => job },
    events: { append: (e: { type: string; data: unknown }) => { events.push(e); }, recent: () => [] },
    tx: <T>(f: () => T): T => f(),
    resourceLedger: { forJob: () => [], open: () => [], retain: () => {}, close: () => {} },
  };
  const c = {
    store, clock: { now: () => new Date('2026-10-24T00:00:00Z') }, keepPanes: false, stopping: () => false, trigger: () => {},
    executors: { get: () => ({ cleanup: async () => ({ kept: [], ...(used ? { used } : {}) }) }) },
    machines: { list: async () => [{ id: 'wsl', online: true, executors: ['agent'] }] },
    jobPeaks: { take: (id: string) => (id === 'j' ? metered : undefined), source: (m: unknown) => m },
  };
  return { cleanups: createCleanups(c as never), used: () => events.filter((e) => e.type === 'job.resources_used') };
}

describe('the cleanup with a metered peak', () => {
  it('records the metered peak when the reap read no scope', async () => {
    const s = setup(undefined, 3 * GIB);
    await s.cleanups.run('j');
    expect(s.used()).toEqual([{ type: 'job.resources_used', jobId: 'j', machineId: 'wsl', data: { memoryPeakBytes: 3 * GIB } }]);
  });

  it('adds it to what the reap read when the reap read no peak', async () => {
    const s = setup({ diskBytes: GIB }, 2 * GIB);
    await s.cleanups.run('j');
    expect(s.used().map((e) => e.data)).toEqual([{ diskBytes: GIB, memoryPeakBytes: 2 * GIB }]);
  });

  it('keeps the scope\'s own peak when the reap read one', async () => {
    const s = setup({ memoryPeakBytes: 4 * GIB, cpuSeconds: 10 }, 2 * GIB);
    await s.cleanups.run('j');
    expect(s.used().map((e) => e.data)).toEqual([{ memoryPeakBytes: 4 * GIB, cpuSeconds: 10 }]);
  });

  it('records nothing when neither read a peak or anything else', async () => {
    const s = setup(undefined, undefined);
    await s.cleanups.run('j');
    expect(s.used()).toEqual([]);
  });
});
