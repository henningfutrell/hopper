// The blast-radius gate in placement (issue #542, design.md "Blast radius and actor machines"): a gated machine — rated
// at or above the gate, or an actor machine — takes no job by ordinary placement. A job passes when a person let it
// through, or by the admin's rules (a label, a repo, a priority); a job resuming returns to its pane. A job every
// usable machine of which is gated is held at the gate, naming them. Pure.
import { GATE_HOLD, type BlastRadiusInput, type GatePassRules, type Job, type MachineSnapshot } from '../domain/types.ts';

/** Whether a job may run on a gated machine. */
export function passes(job: Job, pass: GatePassRules): boolean {
  if (job.gatePass !== undefined) return true;
  const labels = job.source?.labels ?? [];
  if (pass.labels.some((l) => labels.includes(l))) return true;
  if (job.source?.repo !== undefined && pass.repos.includes(job.source.repo)) return true;
  return pass.minPriority !== undefined && job.priority >= pass.minPriority;
}

/** Why the gate keeps `job` from machine `m`, or undefined. */
export function gateKeeps(machineId: string, job: Job, gate: BlastRadiusInput | undefined): string | undefined {
  if (!gate || job.pendingAnswer !== undefined) return undefined;
  const g = gate.gated.find((x) => x.machineId === machineId);
  return g && !passes(job, gate.pass) ? g.reason : undefined;
}

/**
 * The hold of a job the gate keeps from every machine it could otherwise run on — `usable`: online, of its executor,
 * its pin, and taking new jobs —; undefined when one is not gated for it, or none is usable (another hold says why).
 */
export function gateHold(job: Job, usable: readonly MachineSnapshot[], gate: BlastRadiusInput | undefined): string | undefined {
  if (!gate || usable.length === 0) return undefined;
  const kept = usable.map((m) => ({ id: m.id, reason: gateKeeps(m.id, job, gate) }));
  if (kept.some((k) => k.reason === undefined)) return undefined;
  return `${GATE_HOLD}: ${kept.map((k) => `${k.id} is ${k.reason}`).join(', ')}; only a job let through the gate runs there`;
}
