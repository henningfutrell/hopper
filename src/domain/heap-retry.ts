// The heap retry (issue #2722 part 4, design.md "Heap retry"): a job whose Node process ran out of heap (`job.heap_aborted`)
// runs again once with a larger memory limit, and so a larger Node heap, when its machine has room for it. The failure
// assessor runs such a failed job again once in place of handing it to a person; the run again — the assessor's, a
// person's or any other — takes the larger limit at its start, and records it (`job.heap_retry`). Once in a chain of runs:
// the next heap abort is the heap abort pattern's, or a person's. Pure.
import { nodeHeapMiB } from './build-defaults.ts';
import type { BomPart } from './job-bom.ts';
import type { JobLimits } from './job-limits.ts';
import type { DomainEvent } from './types.ts';

/** The larger memory limit: this many times the job's own. */
export const HEAP_RETRY_FACTOR = 1.5;
/** A larger limit by less than this, in GiB, does not help: no heap retry then. */
export const HEAP_RETRY_MIN_GAIN_GIB = 0.5;

const GIB = 1024 ** 3;

/**
 * What `job.heap_retry` records: the command that ran out of heap in the job it runs again (`rerunOf`); with a larger
 * limit, the job's memory limit and Node heap, and the ones it had; else why not (`skipped`), and it runs with its own.
 */
export type HeapRetry = { command: string; rerunOf: string } & (
  | { memoryMaxGiB: number; heapMiB: number; fromMemoryMaxGiB: number; fromHeapMiB: number; skipped?: undefined }
  | { skipped: string; memoryMaxGiB?: undefined }
);

/** The machine's memory now: what is available, and its memory floor, in bytes (the decider's `floorOf`). */
export interface MemoryNow { availableBytes: number; floorBytes: number }

const down = (gib: number): number => Math.floor(gib * 10) / 10;

/**
 * The heap retry of a job that runs `rerunOf` again, whose `command` ran out of heap: its own limits (`limits`) times
 * `HEAP_RETRY_FACTOR`, at most the memory its machine has above its floor (`memory`), to 0.1 GiB below; the Node heap at
 * its share of that. Skipped with no memory limit, no memory reading, or a gain under `HEAP_RETRY_MIN_GAIN_GIB`.
 */
export function heapRetryOf(command: string, rerunOf: string, limits: JobLimits | undefined, memory: MemoryNow | undefined): HeapRetry {
  const base = limits?.memoryMaxGiB;
  if (base === undefined) return { command, rerunOf, skipped: 'the job has no memory limit to raise' };
  if (!memory) return { command, rerunOf, skipped: 'its machine has no memory reading' };
  const room = (memory.availableBytes - memory.floorBytes) / GIB;
  const memoryMaxGiB = down(Math.min(base * HEAP_RETRY_FACTOR, room));
  if (memoryMaxGiB - base < HEAP_RETRY_MIN_GAIN_GIB) {
    return { command, rerunOf, skipped: `its machine has no room for a larger heap: ${down(Math.max(0, room))} GiB above its memory floor` };
  }
  return { command, rerunOf, memoryMaxGiB, heapMiB: nodeHeapMiB(memoryMaxGiB), fromMemoryMaxGiB: base, fromHeapMiB: nodeHeapMiB(base) };
}

/** The job's limits with the heap retry's memory limit, when it has one. */
export const heapRetryLimits = (limits: JobLimits | undefined, r: Partial<HeapRetry> | undefined): JobLimits | undefined =>
  (typeof r?.memoryMaxGiB === 'number' ? { ...limits, memoryMaxGiB: r.memoryMaxGiB } : limits);

/** The command of the newest heap abort in `events` (`job.heap_aborted`), if any. */
export function abortedCommandOf(events: readonly DomainEvent[]): string | undefined {
  const e = events.filter((x) => x.type === 'job.heap_aborted').at(-1);
  const command = (e?.data as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' && command ? command : e ? 'node' : undefined;
}

/** One part for the heap retry, under machines: done with its larger heap, else skipped with why. */
export function heapRetries(events: readonly DomainEvent[]): BomPart[] {
  return events.filter((e) => e.type === 'job.heap_retry').map((e) => {
    const d = e.data as Partial<HeapRetry>;
    const command = typeof d.command === 'string' && d.command ? d.command.split(' ')[0]! : 'node';
    const raised = typeof d.memoryMaxGiB === 'number';
    return {
      id: `heap-retry:${e.seq}`, group: 'machines', kind: 'heap_retry', label: raised ? `Heap retry: ${command} with a larger heap` : `Heap retry: ${command} with its own heap`,
      status: raised ? 'done' : 'recorded', at: e.at,
      detail: raised ? `memory limit ${d.fromMemoryMaxGiB} → ${d.memoryMaxGiB} GiB, Node heap ${d.fromHeapMiB} → ${d.heapMiB} MiB` : String(d.skipped ?? ''),
      href: '#machines',
    };
  });
}
