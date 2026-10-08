// Issue #461: a lane that frees takes the highest-priority accepted job that fits its machine, oldest first
// among equal priorities. The user order (issue #159) orders jobs of one effective priority only: it never
// puts a lower-priority job ahead of a higher one. The queue order (`queueOrder`) feeds the decider, as the
// engine does it for every Decision.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job, Lane } from '../../src/domain/types.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { queueOrder } from '../../src/engine/queue-order.ts';
import { byPriority } from '../../src/plugins/queue-sorter/priority/index.ts';
import { busy, inputs, job, lane, machine, policy } from '../decider/support.ts';

const ctx = { policy, queueSorter: { name: 'priority', sort: (es) => [...es].sort(byPriority).map((e) => e.job.id) } } as EngineContext;
const at = (min: number) => `2026-10-02T11:${String(min).padStart(2, '0')}:00.000Z`;
const machines = [machine({ id: 'linux', maxLanes: 3 }), machine({ id: 'win-native', maxLanes: 1 })];

/** Free one linux lane at a time, as jobs end, and return the jobs in the order they start. */
function refill(waiting: Job[], rounds: number): string[] {
  const started: string[] = [];
  let left = [...waiting];
  for (let i = 0; i < rounds; i++) {
    const lanes: Lane[] = [
      busy(1, 'running-1', { machineId: 'linux' }), busy(2, 'running-2', { machineId: 'linux' }), lane(3, { machineId: 'linux' }),
      busy(1, 'running-win', { machineId: 'win-native' }),
    ];
    const d = decide(inputs({ machines, lanes, waiting: left, queueOrder: queueOrder(ctx, left) }), `d${i}`);
    started.push(...d.start.map((s) => s.jobId));
    left = left.filter((j) => !d.start.some((s) => s.jobId === j.id));
  }
  return started;
}

describe('a freed lane takes the highest-priority job that fits its machine (issue #461)', () => {
  it('mixed priorities, ranked by an earlier Accept: a refill starts them by priority, oldest first, never a lower one first', () => {
    // An Accept in the Queue view posts the whole accepted queue as the user order: every job then waiting is ranked.
    const waiting = [
      job('low', { priority: 25, createdAt: at(1), accepted: true, userRank: 0 }),
      job('default-old', { priority: 50, createdAt: at(2), accepted: true, userRank: 1 }),
      job('high', { priority: 75, createdAt: at(3), accepted: true, userRank: 2 }),
      job('win', { priority: 85, createdAt: at(4), accepted: true, userRank: 3, machineId: 'win-native' }),
      job('escalated', { priority: 85, createdAt: at(5), accepted: true }),
      job('default-new', { priority: 50, createdAt: at(6), accepted: true }),
    ];
    expect(refill(waiting, 6)).toEqual(['escalated', 'high', 'default-old', 'default-new', 'low']);
  });

  it('a job reprioritized after it was ranked runs at its new priority', () => {
    const waiting = [
      job('ranked-first', { priority: 50, createdAt: at(1), accepted: true, userRank: 0 }),
      job('now-escalated', { priority: 85, createdAt: at(2), accepted: true, userRank: 1 }),
    ];
    expect(refill(waiting, 2)).toEqual(['now-escalated', 'ranked-first']);
  });

  it('the user order still orders jobs of one priority', () => {
    const waiting = [
      job('old', { priority: 50, createdAt: at(1), accepted: true, userRank: 1 }),
      job('new', { priority: 50, createdAt: at(2), accepted: true, userRank: 0 }),
      job('higher', { priority: 60, createdAt: at(3), accepted: true }),
    ];
    expect(queueOrder(ctx, waiting).jobIds).toEqual(['higher', 'new', 'old']);
  });
});
