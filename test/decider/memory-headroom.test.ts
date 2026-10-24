// Issue #2499: placement prefers the machine with the most real headroom, and a machine's lane cap reads what its memory
// holds. A machine's real room is the lower of its lane room and the jobs its memory holds over its floor; of two machines
// with the same real room, the one with more memory over its floor takes the job. A machine whose memory holds no more job
// says so on its lane plan.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { ExpectedCost, Job, MachineSnapshot } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
/** A machine of 14 GiB (floor 1.4 GiB, 2 GiB a job) with `available` GiB available and `lanes` lanes. */
const vm = (id: string, available: number, lanes = 8): MachineSnapshot =>
  machine({ id, maxLanes: lanes, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: available * GIB } });
const jobs = (n: number): Job[] => Array.from({ length: n }, (_, i) => job(`j${i + 1}`));

describe('placement by real headroom (issue #2499)', () => {
  it('of two machines with the same lane room, the one with more memory over its floor takes the job', () => {
    const d = decide(inputs({ machines: [vm('a', 6), vm('b', 12)], waiting: jobs(1) }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('lane room counts only as far as the memory holds jobs', () => {
    // a: 8 lanes, 4 GiB available: memory for 1 job. b: 2 lanes, 12 GiB: memory for 5 jobs, lanes for 2.
    const d = decide(inputs({ machines: [vm('a', 4), vm('b', 12, 2)], waiting: jobs(3) }), 'd1');
    expect(d.start.map((s) => `${s.jobId}@${s.machineId}`)).toEqual(['j1@b', 'j2@b', 'j3@a']);
  });

  it('a job with an expected peak counts real room in jobs of its own peak (issue #2737)', () => {
    // A 6 GiB peak. a: 8 lanes, 9 GiB available: 3 jobs of 2 GiB, but 1 of its peak. b: 2 lanes, 13 GiB: 1 of its peak,
    // and more memory over its floor. In jobs of 2 GiB, a has more real room (3 to 2); in jobs of its peak, the two are equal.
    const heavy: ExpectedCost = { group: 'repo', key: 'heavy', jobs: 8, memoryBytes: { avg: 5 * GIB, peak: 6 * GIB } };
    const d = decide(inputs({ machines: [vm('a', 9), vm('b', 13, 2)], waiting: jobs(1), expectedCosts: { j1: heavy } }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('the Decision names how many more jobs each machine\'s memory holds', () => {
    const d = decide(inputs({ machines: [vm('a', 4), vm('b', 12)] }), 'd1');
    expect(d.reasons).toEqual(expect.arrayContaining([
      'a: memory for 1 more job (2.6 GiB over its floor of 1.4 GiB)',
      'b: memory for 5 more jobs (10.6 GiB over its floor of 1.4 GiB)',
    ]));
  });

  it('a machine with free lanes whose memory holds no more job says so on its lane plan', () => {
    const d = decide(inputs({ machines: [vm('a', 3)], waiting: jobs(1) }), 'd1');
    expect(d.wait.map((w) => w.jobId)).toEqual(['j1']);
    expect(d.lanes.find((l) => l.machineId === 'a')?.idle)
      .toBe('memory holds no more job: 3 GiB available, and a new job needs 2 GiB over its floor of 1.4 GiB');
  });
});
