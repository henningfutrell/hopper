// The sweep and the retention per job status (issue #2494, design.md "The sweep"): an ended job's scratch dir stays for
// its machine's retention for the status it ended in, counted from its end; a low disk reaps it whatever the retention.
import { describe, expect, it } from 'vitest';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import type { Survey } from '../../src/domain/ports.ts';
import { HOUR, job, none, rig } from './sweep-rig.ts';

const NOW = Date.parse('2026-10-08T00:00:00Z');
const GIB = 1024 ** 3;
const endedAgo = (id: string, status: Job['status'], hours: number): Job =>
  ({ ...job(id, status), finishedAt: new Date(NOW - hours * HOUR).toISOString() });
const dir = (jobId: string, ageMs: number) => ({ jobId, path: `/w/.worktrees/@scratch/${jobId}`, ageMs });
const found: Survey = { ...none, scratch: [dir('f-young', 99 * HOUR), dir('f-old', 1 * HOUR), dir('done', 25 * HOUR)], roots: ['/w'] };
const machine = (low = false): MachineSnapshot => ({
  id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'], sweep: { retainHours: { failed: 48 } },
  ...(low ? { disk: { freeBytes: 2 * GIB, totalBytes: 100 * GIB, low: true } } : {}),
});
const others = [endedAgo('f-young', 'failed', 47), endedAgo('f-old', 'failed', 49)];

describe('the sweep and the retention per job status (issue #2494)', () => {
  it('keeps a failed job\'s scratch dir for the failed retention from its end; another status by the scratch age', async () => {
    const r = rig({ found, machines: [machine()], others });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([
      { jobId: 'done', scratch: '/w/.worktrees/@scratch/done' },
      { jobId: 'f-old', scratch: '/w/.worktrees/@scratch/f-old' },
    ]);
  });

  it('a low disk reaps every ended job\'s scratch dir, whatever the retention', async () => {
    const r = rig({ found, machines: [machine(true)], others });
    await r.sweep.run(true);
    expect(r.reaps.map((x) => x.jobId)).toEqual(['done', 'f-old', 'f-young']);
  });
});
