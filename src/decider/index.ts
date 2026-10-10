import type { Decision, DecisionInputs, Divergence, Lane } from '../domain/types.ts';
import { assign, bringsToGate, cleanupHold, effectivePriority, nativeHold, order, pinOf, problemHold } from './assign.ts';
import type { Candidate, MachineState } from './assign.ts';
import { divergence, routerVerdict } from './router-verdict.ts';
import { idleReason, planGoneLanes, planLanes } from './lanes.ts';
import { laneSlots } from './priority-lanes.ts';
import { laneEffect, placementPressure } from './usage.ts';

/** The hold of a job waiting at the queue gate (issue #159). */
export const AWAITING_ACCEPTANCE = 'awaiting acceptance';
/** Its item's text changed since the snapshot (issue #662): a person keeps the original, accepts the new text, or cancels it. */
export const TEXT_CHANGED = 'its item changed since the snapshot: keep the original, accept the new text, or cancel';

/** Pure: same inputs, same Decision. `inputs.at` is the clock; `decisionId` is supplied. */
export function decide(inputs: DecisionInputs, decisionId: string): Decision {
  const { policy, machines, lanes } = inputs;
  const reasons: string[] = [];

  const onQuestion = [...inputs.waiting, ...inputs.running].filter((j) => j.status === 'waiting_answer');
  for (const j of onQuestion) reasons.push(`ignored ${j.id}: status waiting_answer is not an input`);
  const waiting = inputs.waiting.filter((j) => j.status !== 'waiting_answer');

  const executorOf = new Map([...inputs.waiting, ...inputs.running].map((j) => [j.id, j.spec.executor]));
  const pinById = new Map([...inputs.waiting, ...inputs.running].map((j) => [j.id, pinOf(j)]));
  const states: MachineState[] = machines.map((machine) => {
    const { usedFrac, cap, band, ignored, burning, executors } = laneEffect(machine, inputs.usage, policy, inputs.at);
    for (const r of ignored) reasons.push(`ignored usage reading ${r.source}: limit ${r.limit} is not positive`);
    for (const r of burning) {
      reasons.push(`${machine.id}: usage window ${r.window} of ${r.source} is in its burn window (resets ${r.resetsAt}, used ${Math.round((r.used / r.limit) * 100)}%): not throttling`);
    }
    const mine = lanes.filter((l) => l.machineId === machine.id);
    const held = mine.filter((l) => l.state !== 'idle');
    reasons.push(`${machine.id}: ${Math.round(usedFrac * 100)}% used, lane cap ${cap} of ${machine.maxLanes} (${band})${machine.reservedLanes ? `, ${machine.reservedLanes} reserved for jobs pinned to it` : ''}`);
    for (const e of executors.filter((x) => x.cap !== cap || x.band !== band)) {
      reasons.push(`${machine.id} ${e.executor}: ${Math.round(e.usedFrac * 100)}% used, lane cap ${e.cap} of ${machine.maxLanes} (${e.band})`);
    }
    return {
      machine, cap, band, usedFrac, assigned: 0, overCap: 0,
      occupied: held.length,
      problems: (inputs.problems ?? []).filter((b) => b.machineId === undefined || b.machineId === machine.id),
      // A lane whose job is unknown counts as unpinned: the reserve stays free (issue #372).
      unpinned: held.filter((l) => l.jobId === undefined || pinById.get(l.jobId) !== machine.id).length,
      freeIdle: mine.filter((l) => l.state === 'idle').sort((a, b) => a.id.localeCompare(b.id)),
      slots: laneSlots(machine.id, lanes, inputs.priorityLanes),
      ...(inputs.blastRadius?.gated.some((g) => g.machineId === machine.id) ? { gate: inputs.blastRadius } : {}),
      executors: new Map(executors.map((e) => [e.executor, {
        cap: e.cap, band: e.band, usedFrac: e.usedFrac, assigned: 0,
        pressure: policy.pacing?.resetAwarePlacement ? placementPressure(machine.id, inputs.usage, inputs.at, policy, e.executor) : 0,
        occupied: held.filter((l) => l.jobId !== undefined && executorOf.get(l.jobId) === e.executor).map((l) => l.id),
      }])),
    };
  });
  const idleByMachine = new Map<string, Lane[]>(states.map((s) => [s.machine.id, [...s.freeIdle]]));

  const hold: Decision['hold'] = [];
  const advice: Divergence[] = [];
  const candidates: Candidate[] = [];
  for (const job of waiting) {
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
    const native = nativeHold(job, machines, inputs.unavailableExecutors) ?? cleanupHold(job, inputs.cleanupDue ?? []) ?? problemHold(job, machines, inputs.problems ?? [])
      ?? bringsToGate(job, machines, inputs.problems ?? [], inputs.blastRadius);
    if (!native && job.pendingAnswer !== undefined) {
      // Admitted once already: the router neither holds nor reorders it.
      candidates.push({
        job, effectivePriority: effectivePriority(job, policy), note: `resume boost +${policy.resumeBoost}`,
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
  const placed = assign(order(candidates, inputs.queueOrder?.jobIds), states, policy, inputs.priorityLanes);
  const priorityOf = new Map(inputs.running.map((j) => [j.id, j.priority]));

  const taken = new Set(placed.start.map((s) => s.laneId));
  const plans = states.map((s) => {
    const unassigned = (idleByMachine.get(s.machine.id) ?? []).filter((l) => !taken.has(l.id));
    const plan = planLanes(s, unassigned, lanes, placed.start, inputs.at, policy.laneIdleGraceMs, priorityOf);
    const idle = idleReason(s, hold, placed.wait);
    return idle === undefined ? plan : { ...plan, idle };
  });
  const listed = new Set(machines.map((m) => m.id));
  const gone = [...new Set(lanes.map((l) => l.machineId).filter((id) => !listed.has(id)))].sort();
  plans.push(...gone.map((id) => planGoneLanes(id, lanes)));

  reasons.push(
    `${waiting.length} waiting, ${placed.start.length} start, ${hold.length} held, ${placed.wait.length} waiting for a lane`,
    ...advice.map((d) => `advice ${d.advice} on ${d.jobId}: native ${d.native}, with advice ${d.withAdvice}`),
  );
  return {
    id: decisionId, at: inputs.at, trigger: inputs.trigger,
    lanes: plans, start: placed.start, hold, wait: placed.wait, advice, reasons, inputs,
  };
}
