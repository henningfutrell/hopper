import type { Job, Lane, MachineSnapshot, StartPlan, HoldPlan } from '../domain/types.ts';
import type { CapBand } from './usage.ts';

export interface MachineState {
  machine: MachineSnapshot;
  cap: number;
  band: CapBand;
  usedFrac: number;
  /** Lanes busy or draining. */
  occupied: number;
  /** Idle lanes, not yet given to a job, in id order. */
  freeIdle: Lane[];
  assigned: number;
}

export interface Candidate {
  job: Job;
  effectivePriority: number;
}

/** Step 5: a hold that applies regardless of Jev, or undefined. */
export function nativeHold(job: Job, machines: MachineSnapshot[]): string | undefined {
  const executor = job.spec.executor;
  const pin = job.spec.machineId;
  if (!machines.some((m) => m.online && m.executors.includes(executor))) {
    return `no online machine runs executor ${executor}`;
  }
  if (pin === undefined) return undefined;
  const pinned = machines.find((m) => m.id === pin);
  if (!pinned) return `pinned machine ${pin} unknown`;
  if (!pinned.online) return `pinned machine ${pin} offline`;
  if (!pinned.executors.includes(executor)) return `pinned machine ${pin} does not run executor ${executor}`;
  return undefined;
}

/** Step 6: priority desc, createdAt asc, id. */
export function order(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) =>
    b.effectivePriority - a.effectivePriority
    || a.job.createdAt.localeCompare(b.job.createdAt)
    || a.job.id.localeCompare(b.job.id));
}

function room(s: MachineState): number {
  return s.cap - s.occupied - s.assigned;
}

function fits(s: MachineState, job: Job): boolean {
  const pin = job.spec.machineId;
  return s.machine.online && s.machine.executors.includes(job.spec.executor)
    && (pin === undefined || pin === s.machine.id) && room(s) > 0;
}

function noRoomReason(job: Job, states: MachineState[]): string {
  const eligible = states.filter((s) => s.machine.online && s.machine.executors.includes(job.spec.executor)
    && (job.spec.machineId === undefined || job.spec.machineId === s.machine.id));
  const best = eligible.reduce((a, b) => (b.cap > a.cap ? b : a));
  if (best.band === 'hard') return `usage hard limit: no lanes (used ${Math.round(best.usedFrac * 100)}%)`;
  if (best.band === 'soft') return `usage soft limit caps lanes at ${best.cap} (used ${Math.round(best.usedFrac * 100)}%)`;
  return `all lanes busy (cap ${best.cap})`;
}

/** Step 7: give each ordered job a machine and an idle lane, or a hold. */
export function assign(ordered: Candidate[], states: MachineState[]): { start: StartPlan[]; hold: HoldPlan[] } {
  const start: StartPlan[] = [];
  const hold: HoldPlan[] = [];
  for (const { job, effectivePriority } of ordered) {
    const options = states.filter((s) => fits(s, job));
    if (options.length === 0) {
      hold.push({ jobId: job.id, reason: noRoomReason(job, states) });
      continue;
    }
    const pick = options.reduce((a, b) => (room(b) > room(a) || (room(b) === room(a) && b.machine.id < a.machine.id) ? b : a));
    const lane = pick.freeIdle.shift();
    pick.assigned += 1;
    start.push({
      jobId: job.id, laneId: lane?.id ?? null, machineId: pick.machine.id, effectivePriority,
      reason: `${lane ? `idle lane ${lane.id}` : 'new lane'} on ${pick.machine.id}, ${room(pick)} room left (cap ${pick.cap})`,
    });
  }
  return { start, hold };
}
