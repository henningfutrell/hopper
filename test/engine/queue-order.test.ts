// Issue #1776: the user order (issue #159) wins over priority — the jobs the user placed run in the user's order,
// whatever their effective priority. Issue #461 still holds for the jobs the user did not place: a job accepted,
// reprioritized or back in the queue later goes ahead of the next placed job when its effective priority is higher,
// so no earlier order freezes it. The queue order (`queueOrder`) feeds the decider, as the engine does it for every
// Decision, and /api/queue (`order` over it), so the round trip from a Queue view move is tested here.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { effectivePriority, order } from '../../src/decider/assign.ts';
import type { Job, Lane } from '../../src/domain/types.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { queueOrder } from '../../src/engine/queue-order.ts';
import { byPriority } from '../../src/plugins/queue-sorter/priority/index.ts';
import { accepting, moved } from '../../ui/src/model/queue.ts';
import { advice, busy, inputs, job, lane, machine, policy } from '../decider/support.ts';

const ctx = { policy, queueSorter: { name: 'priority', sort: (es) => [...es].sort(byPriority).map((e) => e.job.id) } } as EngineContext;
const at = (min: number) => `2026-10-02T11:${String(min).padStart(2, '0')}:00.000Z`;
const machines = [machine({ id: 'linux', maxLanes: 3 }), machine({ id: 'gpu', maxLanes: 1 })];

/** Free one linux lane at a time, as jobs end, and return the jobs in the order they start. */
function refill(waiting: Job[], rounds: number): string[] {
  const started: string[] = [];
  let left = [...waiting];
  for (let i = 0; i < rounds; i++) {
    const lanes: Lane[] = [
      busy(1, 'running-1', { machineId: 'linux' }), busy(2, 'running-2', { machineId: 'linux' }), lane(3, { machineId: 'linux' }),
      busy(1, 'running-gpu', { machineId: 'gpu' }),
    ];
    const d = decide(inputs({ machines, lanes, waiting: left, queueOrder: queueOrder(ctx, left) }), `d${i}`);
    started.push(...d.start.map((s) => s.jobId));
    left = left.filter((j) => !d.start.some((s) => s.jobId === j.id));
  }
  return started;
}

/** /api/queue's `waiting`, as `getQueue` reads it: the decider's order over the queue order. */
const view = (jobs: readonly Job[]): string[] => {
  const waiting = jobs.filter((j) => j.status === 'queued' || j.status === 'held');
  const candidates = waiting.map((j) => ({ job: j, effectivePriority: effectivePriority(j, policy) }));
  return order(candidates, queueOrder(ctx, waiting).jobIds).map((x) => x.job.id);
};

/** `orderQueue`: the listed jobs ranked 0..n-1 and accepted, every other job's rank gone, whatever its status. */
const post = (jobs: readonly Job[], ids: readonly string[]): Job[] => jobs.map((j) => {
  const rank = ids.indexOf(j.id);
  const { userRank: _, ...rest } = j;
  return rank < 0 ? rest : { ...rest, accepted: true, userRank: rank };
});

describe('the user order wins over priority (issue #1776)', () => {
  const mixed = () => [
    job('h', { priority: 75, createdAt: at(1), accepted: true }),
    job('p', { priority: 50, createdAt: at(2), accepted: true, pendingAnswer: 'yes' }),
    job('r', { priority: 50, createdAt: at(3), accepted: true, advice: advice('run_deterministic') }),
    job('a', { priority: 50, createdAt: at(4), accepted: true }),
    job('pre', { priority: 50, createdAt: at(5), accepted: true, preempted: { at: at(6), by: 'x', byPriority: 90, priority: 50, machineId: 'linux' } }),
    job('b', { priority: 25, createdAt: at(7), accepted: true }),
  ];

  it('the queue shows the sorter\'s order by effective priority until the user places a job', () => {
    // h 75, p 50+20 resuming, r 50+10 router-cheap, then a and the preempted job (no boost), oldest first, b.
    expect(view(mixed())).toEqual(['h', 'p', 'r', 'a', 'pre', 'b']);
  });

  it('Move to the top from the last place: first, whatever the priorities and boosts, and the decider starts it first', () => {
    const jobs = mixed();
    const shown = view(jobs);
    const next = post(jobs, moved(shown, 'b', 'top'));
    expect(view(next)).toEqual(['b', 'h', 'p', 'r', 'a', 'pre']);
    expect(refill(next, 1)).toEqual(['b']);
  });

  it('every job moves to every place: the top two swap; a job moves up past a boosted one and down past a lower one', () => {
    for (const [id, by, want] of [
      ['p', -1, ['p', 'h', 'r', 'a', 'pre', 'b']],
      ['h', 1, ['p', 'h', 'r', 'a', 'pre', 'b']],
      ['a', -1, ['h', 'p', 'a', 'r', 'pre', 'b']],
      ['pre', 'top', ['pre', 'h', 'p', 'r', 'a', 'b']],
      ['b', -1, ['h', 'p', 'r', 'a', 'b', 'pre']],
    ] as const) {
      const jobs = mixed();
      expect(view(post(jobs, moved(view(jobs), id, by)))).toEqual(want);
    }
  });

  it('a placed job stays where it is put across Decisions: the order read again is the same', () => {
    const once = post(mixed(), moved(view(mixed()), 'b', 'top'));
    expect(view(once)).toEqual(view(post(once, view(once))));
  });

  it('a job back in the queue with a stale rank never takes the place: the order that ranked others cleared it', () => {
    const back = job('back', { priority: 50, createdAt: at(0), status: 'running', accepted: true, userRank: 0 });
    const jobs = post([...mixed(), back], moved(view(mixed()), 'b', 'top'));
    expect(jobs.find((j) => j.id === 'back')!.userRank).toBeUndefined();
    // It returns unranked: it goes ahead of the first placed job of lower priority only.
    const returned = jobs.map((j) => (j.id === 'back' ? { ...j, status: 'queued' as const } : j));
    expect(view(returned)).toEqual(['back', 'b', 'h', 'p', 'r', 'a', 'pre']);
  });

  it('Accept at the top: a pre-sorted job accepted at the top is first', () => {
    const jobs = [...mixed(), job('n', { priority: 25, createdAt: at(9), accepted: false })];
    const shown = view(jobs).filter((id) => id !== 'n');
    expect(view(post(jobs, accepting(shown, 'n', 'top')))[0]).toBe('n');
    expect(view(post(jobs, accepting(shown, 'n'))).at(-1)).toBe('n');
  });
});

describe('a job the user did not place waits at its priority (issue #461)', () => {
  it('a job accepted later, of higher priority, goes ahead of the placed jobs of lower priority', () => {
    // An Accept in the Queue view posts the whole accepted queue as the user order: every job then waiting is ranked.
    const waiting = [
      job('high', { priority: 75, createdAt: at(3), accepted: true, userRank: 0 }),
      job('default-old', { priority: 50, createdAt: at(2), accepted: true, userRank: 1 }),
      job('low', { priority: 25, createdAt: at(1), accepted: true, userRank: 2 }),
      job('gpu', { priority: 85, createdAt: at(4), accepted: true, userRank: 3, machineId: 'gpu' }),
      job('escalated', { priority: 85, createdAt: at(5), accepted: true }),
      job('default-new', { priority: 50, createdAt: at(6), accepted: true }),
    ];
    expect(refill(waiting, 6)).toEqual(['escalated', 'high', 'default-old', 'default-new', 'low']);
  });

  it('the user order orders jobs of one priority too', () => {
    const waiting = [
      job('old', { priority: 50, createdAt: at(1), accepted: true, userRank: 1 }),
      job('new', { priority: 50, createdAt: at(2), accepted: true, userRank: 0 }),
      job('higher', { priority: 60, createdAt: at(3), accepted: true }),
    ];
    expect(queueOrder(ctx, waiting).jobIds).toEqual(['higher', 'new', 'old']);
  });
});
