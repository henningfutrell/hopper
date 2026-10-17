// The Queue view (issue #159): the two columns — the pre-sort (waiting jobs not yet accepted, in the
// pre-sort's order, each with the reason it would reject it) and the user order (accepted waiting
// jobs, in queue order) — and the user orders a move posts (POST /ui/api/queue/order), to any place (issue #1776). Issue #201: how many
// jobs wait on the pre-sort, the Queue nav badge. Issue #737: which job cards are open — collapsed by default.
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

/** The user order once a pre-sorted job is accepted: it joins at the end, or at the top. */
export const accepting = (order: readonly string[], id: string, at: 'top' | 'end' = 'end'): string[] => {
  const rest = order.filter((x) => x !== id);
  return at === 'top' ? [id, ...rest] : [...rest, id];
};

/**
 * The user order with one job moved up (-1), down (1) or to the top of the whole order (issue #1776: the user order
 * wins over priority); at an edge nothing moves.
 */
export function moved(order: readonly string[], id: string, by: -1 | 1 | 'top'): string[] {
  const from = order.indexOf(id);
  const to = by === 'top' ? 0 : from + by;
  if (from < 0 || to < 0 || to >= order.length || to === from) return [...order];
  const next = order.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

/** Why a move moves nothing: the job is at that edge already. Undefined: it moves. */
export function stillWhy(order: readonly string[], id: string, by: -1 | 1 | 'top'): string | undefined {
  const at = order.indexOf(id);
  if (by !== 1 && at === 0) return 'already first';
  if (by === 1 && at === order.length - 1) return 'already last';
  return undefined;
}

/** What a job of the user order shows about its priority (issue #1776): its boost, and a place you gave it above a higher-priority job. */
export interface OrderNotes { boost?: string; aboveHigher?: string }

/** `priorities`: the effective priorities /api/queue gave; a job it lacks counts at its own priority. */
export function orderNotes(userOrder: readonly Job[], priorities: Readonly<Record<string, number>>): Map<string, OrderNotes> {
  const p = (j: Job) => priorities[j.id] ?? j.priority;
  return new Map(userOrder.map((job, i) => {
    const notes: OrderNotes = {};
    const boost = p(job) - job.priority;
    if (boost > 0) notes.boost = `boosted +${boost}: ${job.pendingAnswer !== undefined ? 'resuming after an answer' : `router advice ${job.advice?.action ?? ''}`.trim()}`;
    if (job.userRank !== undefined && userOrder.slice(i + 1).some((j) => p(j) > p(job))) notes.aboveHigher = 'placed by you above a higher-priority job';
    return [job.id, notes];
  }));
}

/** Which job cards are open (issue #737): `all` after Expand all or Collapse all, `own` a card opened or closed on its own since. */
export interface CardsOpen { all: boolean; own: Readonly<Record<string, boolean>> }

/** Every card collapsed: the default. */
export const COLLAPSED: CardsOpen = { all: false, own: {} };

export const cardOpen = (c: CardsOpen, id: string): boolean => c.own[id] ?? c.all;

export const toggleCard = (c: CardsOpen, id: string): CardsOpen => ({ all: c.all, own: { ...c.own, [id]: !cardOpen(c, id) } });

/** Expand all (`true`) or Collapse all (`false`): every card, whatever it was. */
export const setAllCards = (all: boolean): CardsOpen => ({ all, own: {} });
