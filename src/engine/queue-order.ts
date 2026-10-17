// The queue order (design.md "Queue sorter (issue #18)"): the waiting jobs as the queue-sorter role
// orders them, each with the decider's effective priority — with the user order (issue #159) applied
// (issue #1776): the jobs the user placed keep the user's order, whatever their priority; a job the user
// did not place goes ahead of the next placed job only when its effective priority is higher (issue #461:
// a job accepted or reprioritized later is never frozen behind an earlier order). Read for every Decision
// and for /api/queue, so the queue the UI shows is the order the decider uses.
import { effectivePriority } from '../decider/assign.ts';
import type { Job, JobId, QueueOrder } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export function queueOrder(c: EngineContext, waiting: readonly Job[]): QueueOrder {
  const entries = waiting.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) }));
  const sorted = entries.length ? c.queueSorter.sort(entries) : [];
  const priorityOf = new Map(entries.map((e) => [e.job.id, e.effectivePriority]));
  const ranked = entries.filter((e) => e.job.accepted !== false && e.job.userRank !== undefined)
    .sort((a, b) => a.job.userRank! - b.job.userRank!).map((e) => e.job.id);
  const placed = new Set(ranked);
  const rest = sorted.filter((id) => !placed.has(id));
  const jobIds: JobId[] = [];
  let r = 0;
  let u = 0;
  while (r < ranked.length || u < rest.length) {
    const next = r < ranked.length ? priorityOf.get(ranked[r]!)! : -Infinity;
    if (u < rest.length && priorityOf.get(rest[u]!)! > next) jobIds.push(rest[u++]!);
    else jobIds.push(ranked[r++]!);
  }
  return { sorter: c.queueSorter.name, jobIds };
}
