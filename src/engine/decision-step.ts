// One engine pass: gather inputs → decide() → skip a no-op → apply in one transaction.
import { decide } from '../decider/index.ts';
import type { Decision, DecisionInputs, Job, LaneId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { queueOrder } from './queue-order.ts';

export interface Claim { jobId: string; laneId: LaneId }

const WAITING = ['queued', 'held'] as const;
const RUNNING = ['claimed', 'running'] as const;

async function gather(c: EngineContext, trigger: string): Promise<() => DecisionInputs> {
  const [machines, ...readings] = await Promise.all([c.machines.list(), ...c.usage.map((u) => u.poll())]);
  // Store reads happen after the awaits, synchronously with decide and apply: no interleaving.
  return () => {
    const routerMode = c.routerMode();
    const waiting = oldestFirst(c.store.jobs.list({ status: [...WAITING] }));
    return {
      at: nowIso(c),
      trigger,
      routerMode,
      machines,
      lanes: c.store.lanes.list(),
      usage: readings.flat(),
      waiting,
      running: oldestFirst(c.store.jobs.list({ status: [...RUNNING] })),
      unavailableExecutors: c.executors.unavailable(),
      queueOrder: queueOrder(c, waiting, routerMode),
      policy: c.policy,
    };
  };
}

const oldestFirst = (jobs: Job[]): Job[] => [...jobs].reverse();

/** A Decision that changes nothing is not recorded (design.md "The decider"). */
export function isNoOp(d: Decision): boolean {
  if (d.start.length > 0) return false;
  if (d.lanes.some((p) => p.open > 0 || p.close.length > 0 || p.drain.length > 0)) return false;
  const byId = new Map(d.inputs.waiting.map((j) => [j.id, j]));
  return d.hold.every((h) => byId.get(h.jobId)?.holdReason === h.reason);
}

function apply(c: EngineContext, d: Decision): Claim[] {
  const { store } = c;
  store.decisions.save(d);
  store.events.append({
    type: 'decision.made', decisionId: d.id,
    data: { decisionId: d.id, trigger: d.trigger, routerMode: d.routerMode, starts: d.start, holds: d.hold, lanes: d.lanes, divergences: d.advice },
  });
  for (const plan of d.lanes) {
    for (const laneId of plan.close) {
      store.lanes.close(laneId);
      store.events.append({ type: 'lane.closed', laneId, machineId: plan.machineId, decisionId: d.id, data: { reason: plan.reason } });
    }
    for (const laneId of plan.drain) store.lanes.update(laneId, { state: 'draining' });
  }
  const claims: Claim[] = [];
  for (const s of d.start) {
    const laneId = s.laneId ?? store.lanes.open(s.machineId).id;
    if (s.laneId === null) {
      store.events.append({ type: 'lane.opened', laneId, machineId: s.machineId, decisionId: d.id, data: {} });
    }
    const job = store.jobs.get(s.jobId);
    if (!job) continue;
    store.jobs.update(s.jobId, { status: 'claimed', laneId, attempts: job.attempts + 1, holdReason: undefined });
    store.lanes.update(laneId, { state: 'busy', jobId: s.jobId, idleSince: undefined });
    store.events.append({
      type: 'job.claimed', jobId: s.jobId, laneId, machineId: s.machineId, decisionId: d.id,
      data: { attempts: job.attempts + 1, effectivePriority: s.effectivePriority, reason: s.reason },
    });
    claims.push({ jobId: s.jobId, laneId });
  }
  for (const h of d.hold) {
    const job = store.jobs.get(h.jobId);
    if (!job || job.holdReason === h.reason) continue;
    store.jobs.update(h.jobId, { status: 'held', holdReason: h.reason });
    store.events.append({ type: 'job.held', jobId: h.jobId, decisionId: d.id, data: { reason: h.reason } });
  }
  return claims;
}

/** Returns the claims whose executors the caller must start, outside the transaction. */
export async function decisionStep(c: EngineContext, trigger: string, decisionId: string): Promise<Claim[]> {
  const inputs = await gather(c, trigger);
  if (c.stopping()) return [];
  const decision = decide(inputs(), decisionId);
  if (isNoOp(decision)) return [];
  return c.store.tx(() => apply(c, decision));
}
