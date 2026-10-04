// The queue order (design.md "Queue sorter (issue #18)"): the waiting jobs as the queue-sorter role
// orders them, each with the decider's effective priority. Read for every Decision and for
// /api/queue, so the queue the UI shows is the order the decider uses.
import { effectivePriority } from '../decider/assign.ts';
import type { Job, QueueOrder, RouterMode } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export function queueOrder(c: EngineContext, waiting: readonly Job[], mode: RouterMode): QueueOrder {
  const entries = waiting.map((job) => ({ job, effectivePriority: effectivePriority(job, mode, c.policy) }));
  return { sorter: c.queueSorter.name, jobIds: c.queueSorter.sort(entries) };
}
