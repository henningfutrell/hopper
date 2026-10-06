import type { DeciderPolicy, ExecutorUnavailable, Job, JobId, Lane, MachineSnapshot, StartPlan, HoldPlan } from '../domain/types.ts';
import { routerVerdict } from './router-verdict.ts';
import type { CapBand } from './usage.ts';

/** One executor's share of a machine: its own cap, and the lanes its jobs hold there. */
export interface ExecutorState {
  cap: number;
  band: CapBand;
  usedFrac: number;
  /** Ids of the lanes busy or draining with its jobs. */
  occupied: string[];
  assigned: number;
}

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
  /** Per executor the machine runs (issue #140). */
  executors: Map<string, ExecutorState>;
}

export interface Candidate {
  job: Job;
  effectivePriority: number;
  /** Appended to the start reason (e.g. a resume boost). */
  note?: string;
}

/** The machine a job is pinned to: a resuming job returns to the one holding its pane. */
export function pinOf(job: Job): string | undefined {
  return job.pendingAnswer === undefined ? job.spec.machineId : (job.resumeOn ?? job.spec.machineId);
}

/**
 * Step 5: a hold that applies regardless of the router, or undefined. An unavailable executor
 * comes first: its reason says what to fix.
 */
export function nativeHold(job: Job, machines: MachineSnapshot[], unavailable: ExecutorUnavailable[]): string | undefined {
  const executor = job.spec.executor;
  const down = unavailable.find((u) => u.name === executor);
  if (down) return `executor ${executor} unavailable: ${down.reason}`;
  const pin = pinOf(job);
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

/**
 * A waiting job's effective priority: a resuming job's priority plus the resume boost; any other
 * job's priority plus the router's boost. The engine reads it for the queue sorter's input, so the
 * sorter and the decider agree on one notion.
 */
export function effectivePriority(job: Job, policy: DeciderPolicy): number {
  if (job.pendingAnswer !== undefined) return job.priority + policy.resumeBoost;
  return job.priority + routerVerdict(job, policy.routerCheapBoost).boost;
}

/**
 * Step 6: by the queue order when there is one — the jobs it names first, in its order; the rest
 * after them — and otherwise (and among the rest) priority desc, createdAt asc, id.
 */
export function order(candidates: Candidate[], queueOrder?: readonly JobId[]): Candidate[] {
  const rank = new Map<JobId, number>();
  queueOrder?.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const byRank = (a: Candidate, b: Candidate): number => {
    const ra = rank.get(a.job.id);
    const rb = rank.get(b.job.id);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  };
  return [...candidates].sort((a, b) =>
    byRank(a, b)
    || b.effectivePriority - a.effectivePriority
    || a.job.createdAt.localeCompare(b.job.createdAt)
    || a.job.id.localeCompare(b.job.id));
}

function room(s: MachineState): number {
  return s.cap - s.occupied - s.assigned;
}

/** Room for one more job of `executor`: the machine's lanes, and the executor's own cap. */
function roomFor(s: MachineState, executor: string): number {
  const e = s.executors.get(executor);
  return e ? Math.min(room(s), e.cap - e.occupied.length - e.assigned) : 0;
}

function fits(s: MachineState, job: Job): boolean {
  const pin = pinOf(job);
  return s.machine.online && s.machine.executors.includes(job.spec.executor)
    && (pin === undefined || pin === s.machine.id) && roomFor(s, job.spec.executor) > 0;
}

function noRoomReason(job: Job, states: MachineState[]): string {
  const eligible = states.filter((s) => s.machine.online && s.machine.executors.includes(job.spec.executor)
    && (pinOf(job) === undefined || pinOf(job) === s.machine.id));
  const best = eligible.map((s) => s.executors.get(job.spec.executor)!).reduce((a, b) => (b.cap > a.cap ? b : a));
  if (best.band === 'hard') return `usage hard limit: no lanes (used ${Math.round(best.usedFrac * 100)}%)`;
  if (best.band === 'soft') return `usage soft limit caps lanes at ${best.cap} (used ${Math.round(best.usedFrac * 100)}%)`;
  return `all lanes busy (cap ${best.cap})`;
}

/** Step 7: give each ordered job a machine and an idle lane, or a hold. */
export function assign(ordered: Candidate[], states: MachineState[]): { start: StartPlan[]; hold: HoldPlan[] } {
  const start: StartPlan[] = [];
  const hold: HoldPlan[] = [];
  for (const { job, effectivePriority, note } of ordered) {
    const options = states.filter((s) => fits(s, job));
    if (options.length === 0) {
      hold.push({ jobId: job.id, reason: noRoomReason(job, states) });
      continue;
    }
    const ex = job.spec.executor;
    const pick = options.reduce((a, b) => (roomFor(b, ex) > roomFor(a, ex) || (roomFor(b, ex) === roomFor(a, ex) && b.machine.id < a.machine.id) ? b : a));
    const lane = pick.freeIdle.shift();
    pick.assigned += 1;
    pick.executors.get(ex)!.assigned += 1;
    start.push({
      jobId: job.id, laneId: lane?.id ?? null, machineId: pick.machine.id, effectivePriority,
      reason: `${lane ? `idle lane ${lane.id}` : 'new lane'} on ${pick.machine.id}, ${room(pick)} room left (cap ${pick.cap})${note ? `, ${note}` : ''}`,
    });
  }
  return { start, hold };
}
