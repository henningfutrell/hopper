// The Queue view (issue #159): the two columns — the pre-sort (waiting jobs not yet accepted, in the
// pre-sort's order, each with the reason it would reject it) and the user order (accepted waiting
// jobs, in queue order) — and the user orders a move posts (POST /ui/api/queue/order). Issue #201: how many
// jobs wait on the pre-sort, the Queue nav badge.
import { GROUP } from './board.ts';
import type { Job, PreSort } from './wire.ts';

export interface PreSortedRow { job: Job; reject?: string }

export interface QueueColumns {
  presorted: PreSortedRow[];
  userOrder: Job[];
}

/** `waiting`: the waiting jobs in queue order (the job board's). A job the pre-sort does not name follows, in that order. */
export function queueColumns(waiting: readonly Job[], presort: PreSort | null | undefined): QueueColumns {
  const unaccepted = waiting.filter((j) => j.accepted === false);
  const place = new Map((presort?.jobIds ?? []).map((id, i) => [id, i]));
  const at = (j: Job) => place.get(j.id) ?? Infinity;
  const reasons = new Map((presort?.reject ?? []).map((r) => [r.jobId, r.reason]));
  return {
    presorted: [...unaccepted].sort((a, b) => at(a) - at(b)).map((job) => {
      const reject = reasons.get(job.id);
      return reject === undefined ? { job } : { job, reject };
    }),
    userOrder: waiting.filter((j) => j.accepted !== false),
  };
}

/** How many waiting jobs are not yet accepted: they wait on the pre-sort (or the user). */
export const awaitingSort = (jobs: Iterable<Job>): number => [...jobs].filter((j) => GROUP[j.status] === 'waiting' && j.accepted === false).length;

/** The user order once a pre-sorted job is accepted: it joins at the end. */
export const accepting = (order: readonly string[], id: string): string[] => [...order.filter((x) => x !== id), id];

/** The user order with one job moved up (-1), down (1) or to the top; at an edge nothing moves. */
export function moved(order: readonly string[], id: string, by: -1 | 1 | 'top'): string[] {
  const from = order.indexOf(id);
  const to = by === 'top' ? 0 : from + by;
  if (from < 0 || to < 0 || to >= order.length || to === from) return [...order];
  const next = order.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}
