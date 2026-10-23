import type { Decision, DecisionInputs, Divergence, Lane, MachineSnapshot } from '../domain/types.ts';
import { assign, bringsToGate, cleanupHold, effectivePriority, nativeHold, order, pinOf, problemHold } from './assign.ts';
import type { Candidate, MachineState } from './assign.ts';
import { divergence, routerVerdict } from './router-verdict.ts';
import { idleReason, planGoneLanes, planLanes } from './lanes.ts';
import { laneSlots } from './priority-lanes.ts';
import { elbowsInAs } from '../domain/elbow-in.ts';
import { laneEffect, machinePolicy, placementPressure } from './usage.ts';
import { signedOutNote } from './signed-out.ts';
import { preempt } from './preempt.ts'; import { headroomNote, memoryPauses, memoryRoom, poolHosts, waitReleases, type MemoryRoom } from './memory-floor.ts';
import { numberNewLanes, outAt, outReason, withoutOut } from './lane-health.ts';

/** A machine's own usage limits (issue #1860) and soft lanes (issue #2091), as its usage reason names them; nothing when the user's apply. */
const ownLimits = (m: MachineSnapshot): string =>
  (m.usageLimits
    ? `, its own usage limits ${Math.round(m.usageLimits.soft * 100)}% / ${Math.round(m.usageLimits.hard * 100)}%`
      + (m.usageLimits.softLanes === undefined ? '' : `, ${m.usageLimits.softLanes} soft lanes`)
    : '');

/** A machine state's memory room (issue #2291), when one is counted. */
const memoryOf = (memory: MemoryRoom | undefined): { memory?: MemoryRoom } => (memory ? { memory } : {});

/** The hold of a job waiting at the queue gate (issue #159). */
export const AWAITING_ACCEPTANCE = 'awaiting acceptance';
/** Its item's text changed since the snapshot (issue #662): a person keeps the original, accepts the new text, or cancels it. */
export const TEXT_CHANGED = 'its item changed since the snapshot: keep the original, accept the new text, or cancel';

/** Queued before origins were judged (issue #652): nothing starts it until its issue is of a trusted origin or approved. */
export const ORIGIN_PENDING = 'queued before trusted origins: held until its issue is judged — approve its request card in Intake, or cancel it';

/** Pure: same inputs, same Decision. `inputs.at` is the clock; `decisionId` is supplied. */
export function decide(inputs: DecisionInputs, decisionId: string): Decision {
  const { policy, lanes } = inputs;
  // Its unhealthy lanes take no new job (issue #2234): a machine counts as one lane fewer for each out.
  const machines = inputs.machines.map((m) => withoutOut(m, lanes, inputs.at));
  const reasons: string[] = [];

  const onQuestion = [...inputs.waiting, ...inputs.running].filter((j) => j.status === 'waiting_answer');
  for (const j of onQuestion) reasons.push(`ignored ${j.id}: status waiting_answer is not an input`);
  const waiting = inputs.waiting.filter((j) => j.status !== 'waiting_answer');

  const executorOf = new Map([...inputs.waiting, ...inputs.running].map((j) => [j.id, j.spec.executor]));
  const pinById = new Map([...inputs.waiting, ...inputs.running].map((j) => [j.id, pinOf(j)]));
  const states: MachineState[] = machines.map((machine) => {
    const { usedFrac, cap, band, throttle, ignored, burning, executors } = laneEffect(machine, inputs.usage, policy, inputs.at);
    for (const r of ignored) reasons.push(`ignored usage reading ${r.source}: limit ${r.limit} is not positive`);
    for (const r of burning) {
      reasons.push(`${machine.id}: usage window ${r.window} of ${r.source} is in its burn window (resets ${r.resetsAt}, used ${Math.round((r.used / r.limit) * 100)}%): its hard limit is 100%`);
    }
    const signedOut = (inputs.signedOut ?? []).filter((t) => t.machineId === machine.id);
    for (const t of signedOut) reasons.push(signedOutNote(t));
    const mine = lanes.filter((l) => l.machineId === machine.id);
    const held = mine.filter((l) => l.state !== 'idle');
    reasons.push(`${machine.id}: ${Math.round(usedFrac * 100)}% used${throttle?.window ? ` (${throttle.window})` : ''}, lane cap ${cap} of ${machine.maxLanes} (${band})${ownLimits(machine)}${machine.reservedLanes ? `, ${machine.reservedLanes} reserved for jobs pinned to it` : ''}`);
    for (const e of executors.filter((x) => x.cap !== cap || x.band !== band)) {
      reasons.push(`${machine.id} ${e.executor}: ${Math.round(e.usedFrac * 100)}% used, lane cap ${e.cap} of ${machine.maxLanes} (${e.band})`);
    }
    return {
      machine, cap, band, usedFrac, assigned: 0, overCap: 0, placed: { memoryBytes: 0, cpu: 0 }, ...memoryOf(memoryRoom(machine, lanes, inputs.running, inputs.at)),
      occupied: held.length,
      problems: (inputs.problems ?? []).filter((b) => b.machineId === undefined || b.machineId === machine.id),
      // A lane whose job is unknown counts as unpinned: the reserve stays free (issue #372).
      unpinned: held.filter((l) => l.jobId === undefined || pinById.get(l.jobId) !== machine.id).length,
      freeIdle: mine.filter((l) => l.state === 'idle' && !outAt(machine, inputs.at).some((o) => o.laneId === l.id)).sort((a, b) => a.id.localeCompare(b.id)),
      slots: laneSlots(machine.id, lanes, inputs.priorityLanes),
      ...(inputs.blastRadius?.gated.some((g) => g.machineId === machine.id) ? { gate: inputs.blastRadius } : {}),
      ...(signedOut.length ? { signedOut } : {}),
      executors: new Map(executors.map((e) => [e.executor, {
        cap: e.cap, band: e.band, usedFrac: e.usedFrac, assigned: 0,
        pressure: policy.pacing?.resetAwarePlacement ? placementPressure(machine.id, inputs.usage, inputs.at, machinePolicy(machine, policy), e.executor) : 0,
        occupied: held.filter((l) => l.jobId !== undefined && executorOf.get(l.jobId) === e.executor).map((l) => l.id),
      }])),
    };
  });
  poolHosts(states);
  for (const s of states) if (s.memory) reasons.push(headroomNote(s.machine.id, s.memory));
  const idleByMachine = new Map<string, Lane[]>(states.map((s) => [s.machine.id, [...s.freeIdle]]));

  const hold: Decision['hold'] = [];
  const advice: Divergence[] = [];
  const candidates: Candidate[] = [];
  for (const job of waiting) {
    if (job.originPending) {
      // Before every other judgement: no approval or acceptance starts a job whose issue nobody trusted or approved.
      hold.push({ jobId: job.id, reason: ORIGIN_PENDING });
      continue;
    }
    const stamp = inputs.stampHeld?.find((h) => h.jobId === job.id);
    if (stamp) {
      // Issue #655: no job starts without a trust stamp that verifies, at the dispatch minimum or above — resuming or not.
      hold.push({ jobId: job.id, reason: stamp.reason });
      continue;
    }
    if (job.textChange) {
      // Before every other judgement: no approval or acceptance starts a job whose item's text nobody approved.
      hold.push({ jobId: job.id, reason: TEXT_CHANGED });
      continue;
    }
    if (job.accepted === false) {
      // At the queue gate (issue #159): nothing else is judged until it is accepted.
      hold.push({ jobId: job.id, reason: AWAITING_ACCEPTANCE });
      continue;
    }
    const budget = inputs.budgetHeld?.find((h) => h.jobId === job.id);
    if (budget) {
      // Issue #2302 part 5: a day budget reached holds what starts and what goes on, until the next UTC day or a raise.
      hold.push({ jobId: job.id, reason: budget.reason });
      continue;
    }
    const sandboxes = job.pendingAnswer === undefined ? inputs.sandboxesHeld?.find((h) => h.jobId === job.id) : undefined;
    if (sandboxes) {
      // Issue #1471: a job starts only once the sandboxes its prompt names are approved and ready, never to stop mid-run.
      hold.push({ jobId: job.id, reason: sandboxes.reason });
      continue;
    }
    const native = nativeHold(job, machines, inputs.unavailableExecutors, inputs.signedOut, inputs.credentialHeld) ?? cleanupHold(job, inputs.cleanupDue ?? []) ?? problemHold(job, machines, inputs.problems ?? [])
      ?? bringsToGate(job, machines, inputs.problems ?? [], inputs.blastRadius, inputs.signedOut, inputs.credentialHeld);
    if (!native && job.pendingAnswer !== undefined) {
      // Admitted once already: the router neither holds nor reorders it.
      candidates.push({
        job, effectivePriority: effectivePriority(job, policy), note: job.preempted ? 'preempted: no resume boost' : `resume boost +${policy.resumeBoost}`,
      });
      continue;
    }
    const verdict = routerVerdict(job, policy.routerCheapBoost);
    if (native) {
      hold.push({ jobId: job.id, reason: native });
      continue;
    }
    const d = divergence(job, verdict);
    if (d) advice.push(d);
    if (!verdict.admit) hold.push({ jobId: job.id, reason: verdict.reason });
    else candidates.push({ job, effectivePriority: effectivePriority(job, policy) });
  }

  if (inputs.queueOrder) reasons.push(`queue order by ${inputs.queueOrder.sorter}`);
  const ordered = order(candidates, inputs.queueOrder?.jobIds);
  const assigned = assign(ordered, states, policy, inputs.priorityLanes, inputs.expectedCosts, inputs.placementPicks, inputs.credentialHeld, inputs.avoidLanes);
  const placed = { ...assigned, start: numberNewLanes(assigned.start, machines, lanes, inputs.at, inputs.avoidLanes) };
  const priorityOf = new Map(inputs.running.map((j) => [j.id, j.priority]));
  const elbowing = new Set(inputs.running.filter((j) => elbowsInAs(j) !== undefined).map((j) => j.id));

  const taken = new Set(placed.start.map((s) => s.laneId));
  const plans = states.map((s) => {
    const unassigned = (idleByMachine.get(s.machine.id) ?? []).filter((l) => !taken.has(l.id));
    const plan = planLanes(s, unassigned, lanes, placed.start, inputs.at, policy.laneIdleGraceMs, priorityOf, elbowing);
    const reason = idleReason(s, hold, placed.wait);
    const idle = reason === undefined || reason.startsWith('no lanes') ? outReason(s.machine, inputs.at) ?? reason : reason;
    return idle === undefined ? plan : { ...plan, idle };
  });
  const listed = new Set(machines.map((m) => m.id));
  const gone = [...new Set(lanes.map((l) => l.machineId).filter((id) => !listed.has(id)))].sort();
  plans.push(...gone.map((id) => planGoneLanes(id, lanes)));
  const drained = new Set(plans.flatMap((p) => p.drain));
  const preempts = preempt(ordered, placed.wait, inputs.running, lanes, states, drained, inputs.preemption, inputs.at, inputs.priorityLanes);
  const pauses = memoryPauses(machines, lanes, inputs.running, inputs.waiting, inputs.parkingExecutors, inputs.at, new Set(preempts.map((p) => p.jobId)), inputs.memoryPausedAt);
  const releases = waitReleases(inputs.waitSessions, inputs.at);

  reasons.push(
    `${waiting.length} waiting, ${placed.start.length} start, ${hold.length} held, ${placed.wait.length} waiting for a lane`,
    ...advice.map((d) => `advice ${d.advice} on ${d.jobId}: native ${d.native}, with advice ${d.withAdvice}`),
    ...preempts.map((p) => p.reason), ...pauses.map((p) => p.reason), ...releases.map((r) => r.reason),
  );
  return {
    id: decisionId, at: inputs.at, trigger: inputs.trigger,
    lanes: plans, start: placed.start, hold, wait: placed.wait, advice, ...(preempts.length ? { preempt: preempts } : {}), ...(pauses.length ? { memoryPause: pauses } : {}),
    ...(releases.length ? { waitRelease: releases } : {}), reasons, inputs,
  };
}
