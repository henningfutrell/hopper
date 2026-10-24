// The heap retry at a job's start (issue #2722 part 4): a job that runs again a job with a heap abort starts with a larger
// memory limit, recorded once at its first start and kept at every later start; once in its chain of runs.
import { describe, expect, it } from 'vitest';
import { heapRetryMachine } from '../../src/engine/heap-retry.ts';
import type { DomainEvent, Job, MachineSnapshot } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const TSC = 'tsc --noEmit -p .';

function fakeStore(jobs: Partial<Job>[], seeded: { type: string; jobId: string; data: unknown }[]) {
  const events: DomainEvent[] = [];
  const append = (e: { type: string; jobId?: string; machineId?: string; data: unknown }) => {
    const ev = { seq: events.length + 1, id: `e${events.length + 1}`, at: '2026-10-24T10:00:00.000Z', ...e } as DomainEvent;
    events.push(ev);
    return ev;
  };
  for (const e of seeded) append(e);
  const store = {
    events: { append, recent: (n: number, types: string[], jobId?: string) => events.filter((e) => types.includes(e.type) && (jobId === undefined || e.jobId === jobId)).slice(-n) },
    jobs: { get: (id: string) => jobs.find((j) => j.id === id) as Job | undefined },
  };
  return { store, events };
}

const machine = (availableGiB: number): MachineSnapshot => ({
  id: 'desk', maxLanes: 3, executors: ['herdr-claude'], jobLimits: { memoryMaxGiB: 9, cpuPercent: 200 },
  resources: { cores: 8, memTotalBytes: 32 * GIB, memAvailableBytes: availableGiB * GIB },
} as unknown as MachineSnapshot);

const clock = { now: () => new Date('2026-10-24T10:00:00.000Z') };

describe('the heap retry at a job\'s start', () => {
  it('raises the scope\'s memory limit of a run again of a heap abort, and records it once', () => {
    const { store, events } = fakeStore([{ id: 'j1' }, { id: 'j2', rerunOf: 'j1' }], [{ type: 'job.heap_aborted', jobId: 'j1', data: { command: TSC } }]);
    const c = { store, clock } as never;
    const j2 = { id: 'j2', rerunOf: 'j1' } as Job;
    const m = heapRetryMachine(c, j2, machine(30));
    expect(m.jobLimits).toEqual({ memoryMaxGiB: 13.5, cpuPercent: 200 });
    // Its floor is 10% of 32 GiB: 3.2 GiB; 30 - 3.2 = 26.8 GiB room, more than 13.5.
    expect(events.filter((e) => e.type === 'job.heap_retry')).toEqual([expect.objectContaining({
      jobId: 'j2', machineId: 'desk', data: { command: TSC, rerunOf: 'j1', memoryMaxGiB: 13.5, heapMiB: 10368, fromMemoryMaxGiB: 9, fromHeapMiB: 6912 },
    })]);
    // A later start, on a machine with less room now: the limit it recorded, and no second record.
    expect(heapRetryMachine(c, j2, machine(5)).jobLimits).toEqual({ memoryMaxGiB: 13.5, cpuPercent: 200 });
    expect(events.filter((e) => e.type === 'job.heap_retry')).toHaveLength(1);
  });

  it('records a skipped heap retry where the machine has no room, and keeps the job\'s own limits', () => {
    const { store, events } = fakeStore([{ id: 'j1' }], [{ type: 'job.heap_aborted', jobId: 'j1', data: { command: TSC } }]);
    const m = heapRetryMachine({ store, clock } as never, { id: 'j2', rerunOf: 'j1' } as Job, machine(12));
    expect(m.jobLimits).toEqual({ memoryMaxGiB: 9, cpuPercent: 200 });
    expect(events.at(-1)).toMatchObject({ type: 'job.heap_retry', data: { skipped: 'its machine has no room for a larger heap: 8.8 GiB above its memory floor' } });
  });

  it('does nothing for a first run, a run again with no heap abort, or a chain that had its heap retry', () => {
    const { store, events } = fakeStore([{ id: 'j1' }, { id: 'j2', rerunOf: 'j1' }, { id: 'j4' }], [
      { type: 'job.heap_retry', jobId: 'j2', data: { command: TSC, rerunOf: 'j1', skipped: 'no room' } },
      { type: 'job.heap_aborted', jobId: 'j2', data: { command: TSC } },
    ]);
    const c = { store, clock } as never;
    const before = events.length;
    expect(heapRetryMachine(c, { id: 'j0' } as Job, machine(30)).jobLimits).toEqual({ memoryMaxGiB: 9, cpuPercent: 200 });
    expect(heapRetryMachine(c, { id: 'j5', rerunOf: 'j4' } as Job, machine(30)).jobLimits).toEqual({ memoryMaxGiB: 9, cpuPercent: 200 });
    expect(heapRetryMachine(c, { id: 'j3', rerunOf: 'j2' } as Job, machine(30)).jobLimits).toEqual({ memoryMaxGiB: 9, cpuPercent: 200 });
    expect(events).toHaveLength(before);
  });
});
