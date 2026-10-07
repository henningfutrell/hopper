import type { DeciderPolicy, ExecutorUnavailable, Job, JobId, Lane, MachineSnapshot, StartPlan, WaitPlan } from '../domain/types.ts';
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
  const running = machines.filter((m) => m.online && m.executors.includes(executor));
  if (running.length === 0) return `no online machine runs executor ${executor}`;
  if (pin === undefined) {
    // Issue #361: a machine whose work tree cannot be made takes no job; the job waits for one that can.
    if (running.every((m) => m.workTreeProblem !== undefined)) {
      return `no machine running executor ${executor} has a usable work tree: ${running.map((m) => `${m.id}: ${m.workTreeProblem}`).join('; ')}`;
    }
    return undefined;
  }
  const pinned = machines.find((m) => m.id === pin);
  if (!pinned) return `pinned machine ${pin} unknown`;
  if (!pinned.online) return `pinned machine ${pin} offline`;
  if (!pinned.executors.includes(executor)) return `pinned machine ${pin} does not run executor ${executor}`;
  if (pinned.workTreeProblem !== undefined) return `pinned machine ${pin}: ${pinned.workTreeProblem}`;
  return undefined;
}

/** A machine that may take a new job of `executor`: online, running it, its work tree usable (issue #361). */
const takes = (m: MachineSnapshot, executor: string): boolean => m.online && m.executors.includes(executor) && m.workTreeProblem === undefined;

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
  return takes(s.machine, job.spec.executor) && (pin === undefined || pin === s.machine.id) && roomFor(s, job.spec.executor) > 0;
}

const percent = (frac: number): string => `${Math.round(frac * 100)}%`;
const usageNote = (band: CapBand, usedFrac: number): string => (band === 'soft' ? ` (usage soft limit, used ${percent(usedFrac)})` : '');

/**
 * Why a job waits for a lane (issue #381): the lane cap that binds on the machine with the most of
 * them — its executor's when that leaves less room than the machine's, else the machine's — with its
 * real number and how many lanes it counts in use.
 */
function waitReason(job: Job, states: MachineState[]): string {
  const ex = job.spec.executor;
  const eligible = states.filter((s) => takes(s.machine, ex) && (pinOf(job) === undefined || pinOf(job) === s.machine.id));
  const s = eligible.reduce((a, b) => (b.executors.get(ex)!.cap > a.executors.get(ex)!.cap ? b : a));
  const e = s.executors.get(ex)!;
  const id = s.machine.id;
  if (e.band === 'hard') return `waiting for a lane: usage hard limit stops executor ${ex} on ${id} (used ${percent(e.usedFrac)})`;
  const executorInUse = e.occupied.length + e.assigned;
  const executorBinds = e.cap - executorInUse < room(s) || (e.cap - executorInUse === room(s) && e.cap < s.cap);
  if (executorBinds) {
    return `waiting for a lane: executor ${ex}'s lane cap on ${id} is ${e.cap}${usageNote(e.band, e.usedFrac)}, all ${executorInUse} in use`;
  }
  return `waiting for a lane: machine ${id}'s lane cap is ${s.cap}${usageNote(s.band, s.usedFrac)}, all ${s.occupied + s.assigned} in use`;
}

/** Step 7: give each ordered job a machine and an idle lane, or leave it waiting for one. */
export function assign(ordered: Candidate[], states: MachineState[]): { start: StartPlan[]; wait: WaitPlan[] } {
  const start: StartPlan[] = [];
  const wait: WaitPlan[] = [];
  for (const { job, effectivePriority, note } of ordered) {
    const options = states.filter((s) => fits(s, job));
    if (options.length === 0) {
      wait.push({ jobId: job.id, reason: waitReason(job, states) });
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
  return { start, wait };
}
