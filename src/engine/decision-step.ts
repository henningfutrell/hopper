// One engine pass: gather inputs → decide() → skip a no-op → apply in one transaction.
import { decide } from '../decider/index.ts';
import { retiredPins } from '../decider/retired.ts';
import { signedOutOf } from '../decider/signed-out.ts';
import { MEMORY_PAUSE_EVERY_MS, preemptionInput, type CleanupDue, type Decision, type DecisionInputs, type ExpectedCost, type Job, type JobId, type Lane, type LaneId, type MachineSnapshot } from '../domain/types.ts';
import { brakeOf, DEFAULT_INTAKE_STRICTNESS } from '../domain/intake-strictness.ts';
import { credentialHeldIds } from '../domain/machine-credentials.ts';
import { nowIso, policyOf, priorityTagOf, type EngineContext } from './context.ts';
import type { PriorityLanes } from './priority-lanes.ts';
import type { BlastRadius } from './blast-radius.ts';
import type { PlacementPicks } from './lane-calls.ts';
import type { TrustChecks } from './trust-checks.ts';
import { KIND_CHECK_PENDING, type KindChecks } from './kind-checks.ts';
import { CHECK_PENDING } from '../domain/trust-stamp.ts';
import { avoidLanesOf } from './lane-health.ts';
import { releaseLane } from './outcome.ts';
import { autoAccept } from './queue-gate.ts';
import { preemptionSettings } from './preemption.ts';
import { queueOrder } from './queue-order.ts';
import { recordWaitReleases, waitSessionsOf } from './wait-release.ts';
import { budgetHeldOf } from './token-budget.ts';

export interface Claim { jobId: string; laneId: LaneId }

/** Jev's checks before a job's first start (issue #655): its trust and its kind. */
export interface PreStartChecks { trust: TrustChecks; kind: KindChecks }

const WAITING = ['queued', 'held'] as const;
const RUNNING = ['claimed', 'running'] as const;

/** A job's expected cost, where one is known (issue #688). */
export type ExpectedCostOf = (job: Job) => ExpectedCost | undefined;

async function gather(c: EngineContext, trigger: string, cleanupDue: () => CleanupDue[], priorityLanes: PriorityLanes, blastRadius: BlastRadius, expected: ExpectedCostOf, picks: PlacementPicks, checks: PreStartChecks): Promise<{ machines: MachineSnapshot[]; inputs: () => DecisionInputs }> {
  const [machines, ...readings] = await Promise.all([c.machines.list(), ...c.usage().map((u) => u.poll())]);
  const signedOut = signedOutOf(c.usage().map((u) => ({ name: u.name, state: u.state?.() })));
  // Store reads happen after the awaits, synchronously with decide and apply: no interleaving.
  return { machines, inputs: () => {
    const waiting = oldestFirst(c.store.jobs.list({ status: [...WAITING] }));
    const expectedCosts = expectedOf(waiting, expected);
    const placementPicks = picks.input(waiting);
    // A rerun of a job that failed for its lane's fault goes to another lane when it can (issue #2234).
    const avoidLanes = avoidLanesOf(waiting, (id) => c.store.jobs.get(id));
    const credentialHeld = credentialHeldOf(c, machines);
    const sandboxesHeld = c.sandboxesHeld(waiting);
    const budgetHeld = budgetHeldOf(c, waiting);
    const parkingExecutors = c.executors.names().filter((n) => c.executors.get(n)?.park !== undefined);
    const preemption = preemptionInput(preemptionSettings(c.store), parkingExecutors);
    const waitSessions = waitSessionsOf(c, parkingExecutors);
    const strictness = c.store.settings.getIntakeStrictness() ?? DEFAULT_INTAKE_STRICTNESS;
    // Jev's trust check (issue #655 part 4) and kind check: asked after this Decision's transaction; active, a job waits for them.
    const checking = checks.trust.of(waiting);
    const kindChecking = checks.kind.of(waiting);
    const stampHeld = waiting.flatMap((j) => {
      const reason = c.store.jobs.stampHold(j, brakeOf(strictness, j.source)) ?? (checking(j) ? CHECK_PENDING : kindChecking(j) ? KIND_CHECK_PENDING : undefined);
      return reason ? [{ jobId: j.id, reason }] : [];
    });
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
      ...(expectedCosts ? { expectedCosts } : {}),
      ...(placementPicks ? { placementPicks } : {}),
      ...(avoidLanes ? { avoidLanes } : {}),
      ...(signedOut.length ? { signedOut } : {}),
      ...(credentialHeld.length ? { credentialHeld } : {}),
      ...(sandboxesHeld.length ? { sandboxesHeld } : {}),
      ...(preemption ? { preemption } : {}), parkingExecutors, ...memoryPausedAtOf(c, nowIso(c)), ...(waitSessions.length ? { waitSessions } : {}),
      ...(stampHeld.length ? { stampHeld } : {}),
      ...(budgetHeld.length ? { budgetHeld } : {}),
      policy: policyOf(c),
    };
  } };
}

/** The machines the credential check holds (issue #1467): the same rule the Machines view shows. */
export const credentialHeldOf = (c: EngineContext, machines: readonly MachineSnapshot[]): string[] =>
  credentialHeldIds(machines, c.store.credentialAcceptances.list(), c.store.credentialAcceptances.settings().strict);

const oldestFirst = (jobs: Job[]): Job[] => [...jobs].reverse();

/** Each waiting job's expected cost, where one is known; undefined when none is. A job resuming returns to its pane: none. */
function expectedOf(waiting: readonly Job[], expected: ExpectedCostOf): Record<string, ExpectedCost> | undefined {
  const known = waiting.flatMap((j) => { const e = j.pendingAnswer === undefined ? expected(j) : undefined; return e ? [[j.id, e] as const] : []; });
  return known.length ? Object.fromEntries(known) : undefined;
}

/**
 * Issue #2291: per machine, when this hopper last paused a job there for memory. Kept in memory: between its park and its
 * requeue the paused job is parked and no input, and a second pause must not follow it. A restart forgets it.
 */
const memoryPaused = new WeakMap<EngineContext, Map<string, string>>();
const memoryPausedAtOf = (c: EngineContext, at: string): { memoryPausedAt?: Record<string, string> } => {
  const kept = [...(memoryPaused.get(c) ?? new Map<string, string>())].filter(([, t]) => Date.parse(at) - Date.parse(t) < MEMORY_PAUSE_EVERY_MS);
  return kept.length ? { memoryPausedAt: Object.fromEntries(kept) } : {};
};

/** A Decision that changes nothing is not recorded (design.md "The decider"). */
export function isNoOp(d: Decision): boolean {
  if (d.start.length > 0 || (d.preempt?.length ?? 0) > 0 || (d.memoryPause?.length ?? 0) > 0 || (d.waitRelease?.length ?? 0) > 0) return false;
  if (d.lanes.some((p) => p.open > 0 || p.close.length > 0 || p.drain.length > 0)) return false;
  const byId = new Map(d.inputs.waiting.map((j) => [j.id, j]));
  return d.hold.every((h) => byId.get(h.jobId)?.holdReason === h.reason)
    && d.wait.every((w) => { const j = byId.get(w.jobId); return j?.status === 'queued' && j.waitReason === w.reason; });
}

/** What one Decision asks of the runner: the claims to start, the running jobs to park for preemption (issue #1525), and the jobs on their own wait whose agents end (issue #2303). */
export interface Applied { claims: Claim[]; preempts: JobId[]; releases: JobId[] }

function apply(c: EngineContext, d: Decision): Applied {
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
    // This hopper drives it (issue #1662): a lease left on a waiting job is over.
    c.leases.take(s.jobId, true);
    store.lanes.update(laneId, { state: 'busy', jobId: s.jobId, idleSince: undefined });
    store.events.append({
      type: 'job.claimed', jobId: s.jobId, laneId, machineId: s.machineId, decisionId: d.id,
      data: { attempts: job.attempts + 1, effectivePriority: s.effectivePriority, reason: s.reason },
    });
    claims.push({ jobId: s.jobId, laneId });
  }
  // The held and waiting jobs in one read (issue #1411): a Decision names each waiting job.
  const waiting = store.jobs.getMany([...d.hold.map((h) => h.jobId), ...d.wait.map((w) => w.jobId)]);
  for (const h of d.hold) {
    const job = waiting.get(h.jobId);
    if (!job || job.holdReason === h.reason) continue;
    store.jobs.update(h.jobId, { status: 'held', holdReason: h.reason, waitReason: undefined });
    store.events.append({ type: 'job.held', jobId: h.jobId, decisionId: d.id, data: { reason: h.reason } });
  }
  // Waiting for a lane is not a hold (issue #381): the job stays queued, or returns to queued from a
  // hold — a job held before it for lanes alone, too — and no `job.held` is emitted.
  for (const w of d.wait) {
    const job = waiting.get(w.jobId);
    if (!job || (job.status === 'queued' && job.waitReason === w.reason)) continue;
    store.jobs.update(w.jobId, { status: 'queued', holdReason: undefined, waitReason: w.reason });
  }
  // Preemption (issue #1525): the job is marked here, and parked by the runner after the commit; it is queued again once parked.
  const preempts: JobId[] = [];
  for (const p of d.preempt ?? []) {
    const job = store.jobs.get(p.jobId);
    if (job?.status !== 'running' || job.laneId !== p.laneId) continue;
    store.jobs.update(p.jobId, { preempted: { at: d.at, by: p.by, byPriority: p.byPriority, priority: p.priority, machineId: p.machineId } });
    store.events.append({
      type: 'job.preempted', jobId: p.jobId, laneId: p.laneId, machineId: p.machineId, decisionId: d.id,
      data: { by: p.by, byPriority: p.byPriority, priority: p.priority, reason: p.reason },
    });
    preempts.push(p.jobId);
  }
  // A memory pause (issue #2291): marked here, and parked by the runner after the commit on the preemption's path.
  for (const p of d.memoryPause ?? []) {
    const job = store.jobs.get(p.jobId);
    if (job?.status !== 'running' || job.laneId !== p.laneId || preempts.includes(p.jobId)) continue;
    store.jobs.update(p.jobId, { memoryPaused: { at: d.at, machineId: p.machineId, availableBytes: p.availableBytes, floorBytes: p.floorBytes, priority: p.priority, why: p.why } });
    memoryPaused.set(c, (memoryPaused.get(c) ?? new Map<string, string>()).set(p.machineId, d.at));
    store.events.append({
      type: 'job.memory_paused', jobId: p.jobId, laneId: p.laneId, machineId: p.machineId, decisionId: d.id,
      data: { availableBytes: p.availableBytes, floorBytes: p.floorBytes, reason: p.reason },
    });
    preempts.push(p.jobId);
  }
  // A wait release (issue #2303): marked here; its agent ends after the commit.
  return { claims, preempts, releases: recordWaitReleases(c, d, d.waitRelease ?? []) };
}

/**
 * A lane is held only by a job claimed or running on it (issue #181). One whose job ended without
 * its outcome freeing the lane — cancelled while no runner held it, or a runner that stopped before
 * recording — is freed here, so it never shows running, or blocks a Decision, for good.
 */
function freeStrandedLanes(c: EngineContext): void {
  const { store } = c;
  const held = store.lanes.list().filter((l) => l.state !== 'idle');
  // Their jobs in one read (issue #1411), not one for each lane.
  const jobs = store.jobs.getMany(held.flatMap((l) => (l.jobId ? [l.jobId] : [])));
  const runs = (l: Lane): boolean => {
    const job = l.jobId ? jobs.get(l.jobId) : undefined;
    return !!job && (RUNNING as readonly string[]).includes(job.status) && job.laneId === l.id;
  };
  const stranded = held.filter((l) => !runs(l));
  if (stranded.length) store.tx(() => { for (const l of stranded) releaseLane(c, l, nowIso(c)); });
}

/**
 * A waiting job pinned to a retired machine (issue #919) — one gone from the plugins config, that no machine source lists —
 * fails with the reason: it would wait for it for good. Nothing is judged while the plugins config has an error. Failure
 * handling and Failures take it from there; a run again is placed afresh. No cleanup: its machine is gone, and a deferred
 * one would hold the item's next job.
 */
function failRetiredPins(c: EngineContext, machines: readonly MachineSnapshot[]): void {
  const { store } = c;
  const configured = c.configuredMachines();
  if (configured === undefined) return;
  const retired = retiredPins(store.jobs.list({ status: [...WAITING] }), machines, configured);
  if (!retired.length) return;
  store.tx(() => {
    for (const r of retired) {
      store.jobs.update(r.jobId, { status: 'failed', error: r.reason, finishedAt: nowIso(c), holdReason: undefined, waitReason: undefined, pendingAnswer: undefined });
      store.events.append({ type: 'job.failed', jobId: r.jobId, data: { error: r.reason, ...priorityTagOf(c, r.jobId) } });
    }
  });
}

/** Returns the claims whose executors the caller must start, and the jobs it must park for preemption, outside the transaction. */
export async function decisionStep(c: EngineContext, trigger: string, decisionId: string, cleanupDue: () => CleanupDue[], priorityLanes: PriorityLanes, blastRadius: BlastRadius, expected: ExpectedCostOf, picks: PlacementPicks, checks: PreStartChecks): Promise<Applied> {
  const none: Applied = { claims: [], preempts: [], releases: [] };
  const { machines, inputs } = await gather(c, trigger, cleanupDue, priorityLanes, blastRadius, expected, picks, checks);
  if (c.stopping()) return none;
  freeStrandedLanes(c);
  failRetiredPins(c, machines);
  autoAccept(c);
  return c.store.tx(() => {
    // One hopper at a time claims this user's jobs (issue #1662): the inputs are read under the claim lock.
    c.leases.lockClaims();
    const decision = decide(inputs(), decisionId);
    return isNoOp(decision) ? none : apply(c, decision);
  });
}
