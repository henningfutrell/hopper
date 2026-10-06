// The queue order (design.md "Queue sorter (issue #18)"): the waiting jobs as the queue-sorter role
// orders them, each with the decider's effective priority — after the user order (issue #159): the
// accepted jobs the user ranked come first, by rank. Read for every Decision and for /api/queue, so
// the queue the UI shows is the order the decider uses.
import { effectivePriority } from '../decider/assign.ts';
import type { Job, QueueOrder } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export function queueOrder(c: EngineContext, waiting: readonly Job[]): QueueOrder {
  const entries = waiting.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) }));
  const sorted = entries.length ? c.queueSorter.sort(entries) : [];
  const ranked = waiting.filter((j) => j.accepted !== false && j.userRank !== undefined)
    .sort((a, b) => a.userRank! - b.userRank!).map((j) => j.id);
  const first = new Set(ranked);
  return { sorter: c.queueSorter.name, jobIds: [...ranked, ...sorted.filter((id) => !first.has(id))] };
}
