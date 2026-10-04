import type { Decision, DecisionInputs, Divergence, Lane } from '../domain/types.ts';
import { assign, nativeHold, order } from './assign.ts';
import type { Candidate, MachineState } from './assign.ts';
import { divergence, routerVerdict } from './router-verdict.ts';
import { planGoneLanes, planLanes } from './lanes.ts';
import { laneCap, machineUsage } from './usage.ts';

/** Pure: same inputs, same Decision. `inputs.at` is the clock; `decisionId` is supplied. */
export function decide(inputs: DecisionInputs, decisionId: string): Decision {
  const { policy, machines, lanes } = inputs;
  const reasons: string[] = [];

  const parked = [...inputs.waiting, ...inputs.running].filter((j) => j.status === 'waiting_answer');
  for (const j of parked) reasons.push(`ignored ${j.id}: status waiting_answer is not an input`);
  const waiting = inputs.waiting.filter((j) => j.status !== 'waiting_answer');

  const states: MachineState[] = machines.map((machine) => {
    const { usedFrac, ignored } = machineUsage(machine.id, inputs.usage);
    for (const r of ignored) reasons.push(`ignored usage reading ${r.source}: limit ${r.limit} is not positive`);
    const { cap, band } = laneCap(machine, usedFrac, policy);
    const mine = lanes.filter((l) => l.machineId === machine.id);
    reasons.push(`${machine.id}: ${Math.round(usedFrac * 100)}% used, lane cap ${cap} of ${machine.maxLanes} (${band})`);
    return {
      machine, cap, band, usedFrac, assigned: 0,
      occupied: mine.filter((l) => l.state !== 'idle').length,
      freeIdle: mine.filter((l) => l.state === 'idle').sort((a, b) => a.id.localeCompare(b.id)),
    };
  });
  const idleByMachine = new Map<string, Lane[]>(states.map((s) => [s.machine.id, [...s.freeIdle]]));

  const hold: Decision['hold'] = [];
  const advice: Divergence[] = [];
  const candidates: Candidate[] = [];
  for (const job of waiting) {
    const native = nativeHold(job, machines, inputs.unavailableExecutors);
    if (!native && job.pendingAnswer !== undefined) {
      // Admitted once already: the router neither holds nor reorders it.
      candidates.push({
        job, effectivePriority: job.priority + policy.resumeBoost, note: `resume boost +${policy.resumeBoost}`,
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
    if (inputs.routerMode === 'active') {
      if (verdict.admit) candidates.push({ job, effectivePriority: job.priority + verdict.boost });
      else hold.push({ jobId: job.id, reason: verdict.reason });
    } else {
      candidates.push({ job, effectivePriority: job.priority });
    }
  }

  const placed = assign(order(candidates), states);
  hold.push(...placed.hold);

  const taken = new Set(placed.start.map((s) => s.laneId));
  const plans = states.map((s) => {
    const unassigned = (idleByMachine.get(s.machine.id) ?? []).filter((l) => !taken.has(l.id));
    return planLanes(s, unassigned, lanes, placed.start, inputs.at, policy.laneIdleGraceMs);
  });
  const listed = new Set(machines.map((m) => m.id));
  const gone = [...new Set(lanes.map((l) => l.machineId).filter((id) => !listed.has(id)))].sort();
  plans.push(...gone.map((id) => planGoneLanes(id, lanes)));

  reasons.push(
    `${inputs.routerMode} mode: ${waiting.length} waiting, ${placed.start.length} start, ${hold.length} held`,
    ...advice.map((d) => `advice ${d.advice} on ${d.jobId}: native ${d.native}, with advice ${d.withAdvice}`),
  );
  return {
    id: decisionId, at: inputs.at, trigger: inputs.trigger, routerMode: inputs.routerMode,
    lanes: plans, start: placed.start, hold, advice, reasons, inputs,
  };
}
