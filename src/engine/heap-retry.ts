// The heap retry at a job's start (issue #2722 part 4, design.md "Heap retry", `src/domain/heap-retry.ts`): a job that runs
// again a job whose Node process ran out of heap starts with a larger memory limit, when its machine has room, once in its
// chain of runs. Decided and recorded (`job.heap_retry`) at its first start; every later start and resume of the job, on any
// machine, takes the limit it recorded.
import { floorOf } from '../decider/memory-floor.ts';
import { abortedCommandOf, heapRetryLimits, heapRetryOf, type HeapRetry, type MemoryNow } from '../domain/heap-retry.ts';
import { scopeLimitsOf } from '../domain/job-limits.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { heapRetriedIn } from '../failures/heap-holds.ts';

/** The machine's memory available and floor now: its floor 0 when it is off. */
function memoryNow(m: MachineSnapshot, at: number): MemoryNow | undefined {
  const f = floorOf(m, at);
  if (f) return { availableBytes: f.availableBytes, floorBytes: f.floorBytes };
  return m.resources && m.resources.memTotalBytes > 0 ? { availableBytes: m.resources.memAvailableBytes, floorBytes: 0 } : undefined;
}

/**
 * Machine `m` as job `j`'s scope sees it: with the heap retry's memory limit when the job has one. Its first start decides
 * it — the job runs again a job with a heap abort, and no job of its chain had a heap retry — and records it.
 */
export function heapRetryMachine(c: Pick<EngineContext, 'store' | 'clock'>, j: Job, m: MachineSnapshot): MachineSnapshot {
  const { store } = c;
  const kept = store.events.recent(1, ['job.heap_retry'], j.id)[0]?.data as Partial<HeapRetry> | undefined;
  let retry = kept;
  if (!kept && j.rerunOf !== undefined) {
    const command = abortedCommandOf(store.events.recent(20, ['job.heap_aborted'], j.rerunOf));
    if (command !== undefined && !heapRetriedIn(store, j.rerunOf)) {
      retry = heapRetryOf(command, j.rerunOf, scopeLimitsOf(m), memoryNow(m, c.clock.now().getTime()));
      store.events.append({ type: 'job.heap_retry', jobId: j.id, machineId: m.id, data: retry });
    }
  }
  return typeof retry?.memoryMaxGiB === 'number' ? { ...m, jobLimits: heapRetryLimits(scopeLimitsOf(m), retry) } : m;
}
