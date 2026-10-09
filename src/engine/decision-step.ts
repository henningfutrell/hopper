// One engine pass: gather inputs → decide() → skip a no-op → apply in one transaction.
import { decide } from '../decider/index.ts';
import type { CleanupDue, Decision, DecisionInputs, Job, Lane, LaneId } from '../domain/types.ts';
import { nowIso, policyOf, type EngineContext } from './context.ts';
import type { PriorityLanes } from './priority-lanes.ts';
import type { BlastRadius } from './blast-radius.ts';
import { releaseLane } from './outcome.ts';
import { autoAccept } from './queue-gate.ts';
import { queueOrder } from './queue-order.ts';

export interface Claim { jobId: string; laneId: LaneId }

const WAITING = ['queued', 'held'] as const;
const RUNNING = ['claimed', 'running'] as const;

async function gather(c: EngineContext, trigger: string, cleanupDue: () => CleanupDue[], priorityLanes: PriorityLanes, blastRadius: BlastRadius): Promise<() => DecisionInputs> {
  const [machines, ...readings] = await Promise.all([c.machines.list(), ...c.usage().map((u) => u.poll())]);
  // Store reads happen after the awaits, synchronously with decide and apply: no interleaving.
  return () => {
    const waiting = oldestFirst(c.store.jobs.list({ status: [...WAITING] }));
    return {
      at: nowIso(c),
      trigger,
      machines,
      lanes: c.store.lanes.list(),
      usage: readings.flat(),
      waiting,
      running: oldestFirst(c.store.jobs.list({ status: [...RUNNING] })),
      unavailableExecutors: c.executors.unavailable(),
      queueOrder: queueOrder(c, waiting),
      cleanupDue: cleanupDue(),
      problems: c.problems(),
      priorityLanes: priorityLanes.input(machines),
      blastRadius: blastRadius.input(machines),
      policy: policyOf(c),
    };
  };
}

const oldestFirst = (jobs: Job[]): Job[] => [...jobs].reverse();

/** A Decision that changes nothing is not recorded (design.md "The decider"). */
export function isNoOp(d: Decision): boolean {
  if (d.start.length > 0) return false;
  if (d.lanes.some((p) => p.open > 0 || p.close.length > 0 || p.drain.length > 0)) return false;
  const byId = new Map(d.inputs.waiting.map((j) => [j.id, j]));
  return d.hold.every((h) => byId.get(h.jobId)?.holdReason === h.reason)
    && d.wait.every((w) => { const j = byId.get(w.jobId); return j?.status === 'queued' && j.waitReason === w.reason; });
}

function apply(c: EngineContext, d: Decision): Claim[] {
  const { store } = c;
  store.decisions.save(d);
  store.events.append({
    type: 'decision.made', decisionId: d.id,
    data: { decisionId: d.id, trigger: d.trigger, starts: d.start, holds: d.hold, waits: d.wait, lanes: d.lanes, divergences: d.advice },
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
    const laneId = s.laneId ?? store.lanes.open(s.machineId, s.opens).id;
    if (s.laneId === null) {
      store.events.append({ type: 'lane.opened', laneId, machineId: s.machineId, decisionId: d.id, data: {} });
    }
    const job = store.jobs.get(s.jobId);
    if (!job) continue;
    store.jobs.update(s.jobId, { status: 'claimed', laneId, attempts: job.attempts + 1, holdReason: undefined, waitReason: undefined });
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
    store.jobs.update(h.jobId, { status: 'held', holdReason: h.reason, waitReason: undefined });
    store.events.append({ type: 'job.held', jobId: h.jobId, decisionId: d.id, data: { reason: h.reason } });
  }
  // Waiting for a lane is not a hold (issue #381): the job stays queued, or returns to queued from a
  // hold — a job held before it for lanes alone, too — and no `job.held` is emitted.
  for (const w of d.wait) {
    const job = store.jobs.get(w.jobId);
    if (!job || (job.status === 'queued' && job.waitReason === w.reason)) continue;
    store.jobs.update(w.jobId, { status: 'queued', holdReason: undefined, waitReason: w.reason });
  }
  return claims;
}

/**
 * A lane is held only by a job claimed or running on it (issue #181). One whose job ended without
 * its outcome freeing the lane — cancelled while no runner held it, or a runner that stopped before
 * recording — is freed here, so it never shows running, or blocks a Decision, for good.
 */
function freeStrandedLanes(c: EngineContext): void {
  const { store } = c;
  const runs = (l: Lane): boolean => {
    const job = l.jobId ? store.jobs.get(l.jobId) : undefined;
    return !!job && (RUNNING as readonly string[]).includes(job.status) && job.laneId === l.id;
  };
  const stranded = store.lanes.list().filter((l) => l.state !== 'idle' && !runs(l));
  if (stranded.length) store.tx(() => { for (const l of stranded) releaseLane(c, l, nowIso(c)); });
}

/** Returns the claims whose executors the caller must start, outside the transaction. */
export async function decisionStep(c: EngineContext, trigger: string, decisionId: string, cleanupDue: () => CleanupDue[], priorityLanes: PriorityLanes, blastRadius: BlastRadius): Promise<Claim[]> {
  const inputs = await gather(c, trigger, cleanupDue, priorityLanes, blastRadius);
  if (c.stopping()) return [];
  freeStrandedLanes(c);
  autoAccept(c);
  const decision = decide(inputs(), decisionId);
  if (isNoOp(decision)) return [];
  return c.store.tx(() => apply(c, decision));
}
