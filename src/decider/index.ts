import type { Decision, DecisionInputs, JevDivergence, Lane } from '../domain/types.ts';
import { assign, nativeHold, order } from './assign.ts';
import type { Candidate, MachineState } from './assign.ts';
import { divergence, jevVerdict } from './jev-verdict.ts';
import { planLanes } from './lanes.ts';
import { laneCap, machineUsage } from './usage.ts';

/** Pure: same inputs, same Decision. `inputs.at` is the clock; `decisionId` is supplied. */
export function decide(inputs: DecisionInputs, decisionId: string): Decision {
  const { policy, machines, lanes, waiting } = inputs;
  const reasons: string[] = [];

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
  const jev: JevDivergence[] = [];
  const candidates: Candidate[] = [];
  for (const job of waiting) {
    const native = nativeHold(job, machines);
    const verdict = jevVerdict(job, policy.jevCheapBoost);
    if (native) {
      hold.push({ jobId: job.id, reason: native });
      continue;
    }
    const d = divergence(job, verdict);
    if (d) jev.push(d);
    if (inputs.jevMode === 'active') {
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

  reasons.push(
    `${inputs.jevMode} mode: ${waiting.length} waiting, ${placed.start.length} start, ${hold.length} held`,
    ...jev.map((d) => `jev ${d.advice} on ${d.jobId}: native ${d.native}, with jev ${d.withJev}`),
  );
  return {
    id: decisionId, at: inputs.at, trigger: inputs.trigger, jevMode: inputs.jevMode,
    lanes: plans, start: placed.start, hold, jev, reasons, inputs,
  };
}
