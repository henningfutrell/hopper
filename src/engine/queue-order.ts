// The queue order (design.md "Queue sorter (issue #18)"): the waiting jobs as the queue-sorter role
// orders them, each with the decider's effective priority — with the user order (issue #159) applied
// inside each effective priority (issue #461): the places the sorter gives one priority's jobs go to
// those the user ranked first, by rank, then to the rest in the sorter's order. A ranked job never moves
// ahead of a job of higher priority. Read for every Decision and for /api/queue, so the queue the UI
// shows is the order the decider uses.
import { effectivePriority } from '../decider/assign.ts';
import type { Job, JobId, QueueOrder } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export function queueOrder(c: EngineContext, waiting: readonly Job[]): QueueOrder {
  const entries = waiting.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) }));
  const sorted = entries.length ? c.queueSorter.sort(entries) : [];
  const priorityOf = new Map(entries.map((e) => [e.job.id, e.effectivePriority]));
  const ranked = entries.filter((e) => e.job.accepted !== false && e.job.userRank !== undefined)
    .sort((a, b) => a.job.userRank! - b.job.userRank!).map((e) => e.job.id);
  const listed = new Set(sorted);
  const places = [...sorted, ...ranked.filter((id) => !listed.has(id))];
  const first = new Set(ranked);
  const byPriority = new Map<number, JobId[]>();
  for (const id of [...ranked, ...places.filter((id) => !first.has(id))]) {
    const p = priorityOf.get(id)!;
    byPriority.set(p, [...(byPriority.get(p) ?? []), id]);
  }
  return { sorter: c.queueSorter.name, jobIds: places.map((id) => byPriority.get(priorityOf.get(id)!)!.shift()!) };
}
