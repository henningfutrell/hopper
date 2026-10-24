// The heap retry (issue #2722 part 4), pure: a run again of a job whose Node process ran out of heap gets 1.5 times its
// memory limit, at most what its machine has above its memory floor, and a Node heap at its share of that.
import { describe, expect, it } from 'vitest';
import { abortedCommandOf, heapRetries, heapRetryLimits, heapRetryOf } from '../../src/domain/heap-retry.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
const TSC = 'tsc --noEmit -p .';
const room = (availableGiB: number, floorGiB = 3) => ({ availableBytes: availableGiB * GIB, floorBytes: floorGiB * GIB });
const event = (type: string, data: unknown, seq = 1): DomainEvent => ({ seq, id: `e${seq}`, type, at: '2026-10-24T10:00:00.000Z', jobId: 'j2', data } as DomainEvent);

describe('the heap retry', () => {
  it('raises the memory limit 1.5 times, and the Node heap to its share of it', () => {
    expect(heapRetryOf(TSC, 'j1', { memoryMaxGiB: 9, cpuPercent: 200 }, room(30))).toEqual({
      command: TSC, rerunOf: 'j1', memoryMaxGiB: 13.5, heapMiB: 10368, fromMemoryMaxGiB: 9, fromHeapMiB: 6912,
    });
  });

  it('raises it at most to the memory above the machine\'s floor', () => {
    expect(heapRetryOf(TSC, 'j1', { memoryMaxGiB: 9 }, room(14.27))).toMatchObject({ memoryMaxGiB: 11.2, heapMiB: 8601 });
  });

  it('is skipped with no room for 0.5 GiB more, no memory limit, or no memory reading', () => {
    expect(heapRetryOf(TSC, 'j1', { memoryMaxGiB: 9 }, room(12.4))).toEqual({
      command: TSC, rerunOf: 'j1', skipped: 'its machine has no room for a larger heap: 9.4 GiB above its memory floor',
    });
    expect(heapRetryOf(TSC, 'j1', { memoryMaxGiB: 9 }, room(2))).toMatchObject({ skipped: 'its machine has no room for a larger heap: 0 GiB above its memory floor' });
    expect(heapRetryOf(TSC, 'j1', { cpuPercent: 200 }, room(30))).toEqual({ command: TSC, rerunOf: 'j1', skipped: 'the job has no memory limit to raise' });
    expect(heapRetryOf(TSC, 'j1', { memoryMaxGiB: 9 }, undefined)).toEqual({ command: TSC, rerunOf: 'j1', skipped: 'its machine has no memory reading' });
  });

  it('gives the job\'s limits its memory limit, and keeps them when it was skipped', () => {
    expect(heapRetryLimits({ memoryMaxGiB: 9, cpuPercent: 200 }, { memoryMaxGiB: 13.5 })).toEqual({ memoryMaxGiB: 13.5, cpuPercent: 200 });
    expect(heapRetryLimits({ memoryMaxGiB: 9 }, { skipped: 'no room' })).toEqual({ memoryMaxGiB: 9 });
    expect(heapRetryLimits(undefined, undefined)).toBeUndefined();
  });

  it('reads the command of the newest heap abort', () => {
    expect(abortedCommandOf([event('job.heap_aborted', { command: 'vite build' }), event('job.heap_aborted', { command: TSC })])).toBe(TSC);
    expect(abortedCommandOf([event('job.heap_aborted', {})])).toBe('node');
    expect(abortedCommandOf([event('job.failed', { command: TSC })])).toBeUndefined();
  });

  it('is a part of the job under machines', () => {
    expect(heapRetries([
      event('job.heap_retry', { command: TSC, rerunOf: 'j1', memoryMaxGiB: 13.5, heapMiB: 10368, fromMemoryMaxGiB: 9, fromHeapMiB: 6912 }, 4),
      event('job.heap_retry', { command: TSC, rerunOf: 'j1', skipped: 'its machine has no memory reading' }, 5),
    ])).toEqual([
      { id: 'heap-retry:4', group: 'machines', kind: 'heap_retry', label: 'Heap retry: tsc with a larger heap', status: 'done', at: '2026-10-24T10:00:00.000Z', detail: 'memory limit 9 → 13.5 GiB, Node heap 6912 → 10368 MiB', href: '#machines' },
      { id: 'heap-retry:5', group: 'machines', kind: 'heap_retry', label: 'Heap retry: tsc with its own heap', status: 'recorded', at: '2026-10-24T10:00:00.000Z', detail: 'its machine has no memory reading', href: '#machines' },
    ]);
  });
});
