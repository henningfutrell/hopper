import type { CleanupDue, DeciderPolicy, ExecutorUnavailable, Job, JobId, Lane, MachineSnapshot, PriorityLanesInput, ProblemBlock, StartPlan, WaitPlan } from '../domain/types.ts';
import { freePriority, holdingBestFree, isHigh, keptFor, pickLane, priorityLaneNames, type LaneSlots } from './priority-lanes.ts';
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
  /** Placement pressure of its account here (issue #373); 0 when reset-aware placement is off. */
  pressure: number;
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
  /** Lanes over the cap this Decision gave critical jobs: at most 1 (issue #373). */
  overCap: number;
  /** Lanes busy or draining, and starts, of jobs not pinned to it (issue #372). */
  unpinned: number;
  /** Per executor the machine runs (issue #140). */
  executors: Map<string, ExecutorState>;
  /** Open problems on this machine (issue #509): a new job of an executor one names is placed elsewhere. */
  problems?: ProblemBlock[];
  /** Its priority lanes and which of its lanes are open or in use (issue #535). */
  slots: LaneSlots;
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
 * A machine whose disk is low takes no new job (issue #410): a job resuming there returns to the pane it
 * holds. Low is judged by the machine's own thresholds (src/machines/disk.ts).
 */
export const diskHolds = (m: MachineSnapshot, job: Job): boolean => m.disk?.low === true && job.pendingAnswer === undefined;

/**
 * A machine whose work tree cannot be made usable takes no new job (issue #361): the job waits for one
 * that can, never fails there. A job resuming there returns to the pane it holds.
 */
export const workTreeHolds = (m: MachineSnapshot, job: Job): boolean => m.workTreeProblem !== undefined && job.pendingAnswer === undefined;

const GIB = 1024 ** 3;
const freeOf = (m: MachineSnapshot): string => `${Math.round((m.disk!.freeBytes / GIB) * 10) / 10} GiB free`;
export const NO_NEW_JOB = 'no new job is claimed there';

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
    const known = running.filter((m) => !homeless(m));
    if (known.length === 0) {
      return `no machine that runs executor ${executor} has its home known yet: ${running.map((m) => m.id).join(', ')} ${running.length > 1 ? 'have' : 'has'} not answered a probe`;
    }
    if (known.every((m) => workTreeHolds(m, job))) {
      return `no machine running executor ${executor} has a usable work tree: ${known.map((m) => `${m.id}: ${m.workTreeProblem}`).join('; ')}`;
    }
    const usable = known.filter((m) => !workTreeHolds(m, job));
    if (usable.every((m) => diskHolds(m, job))) return `disk low on ${usable.map((m) => `${m.id} (${freeOf(m)})`).join(', ')}: ${NO_NEW_JOB}`;
    return undefined;
  }
  const pinned = machines.find((m) => m.id === pin);
  if (!pinned) return `pinned machine ${pin} unknown`;
  if (!pinned.online) return `pinned machine ${pin} offline`;
  if (!pinned.executors.includes(executor)) return `pinned machine ${pin} does not run executor ${executor}`;
  if (homeless(pinned)) return `pinned machine ${pin}: its home is not known yet (it has not answered a probe)`;
  if (workTreeHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.workTreeProblem}`;
  if (diskHolds(pinned, job)) return `pinned machine ${pin} disk low (${freeOf(pinned)}): ${NO_NEW_JOB}`;
  return undefined;
}

/**
 * Issue #365: an ssh or client target whose probe has not found its home yet. `~` in a work tree cannot
 * resolve there, so no job is placed on it until it has; this machine's and a container target's need none.
 */
export const homeless = (m: MachineSnapshot): boolean => (m.ssh !== undefined || m.client !== undefined) && m.home === undefined;

/**
 * Issue #371: an ended job of the same item whose cleanup has not gone through may still run in its pane;
 * starting this one beside it runs the item twice. Held until that cleanup goes through.
 */
export function cleanupHold(job: Job, due: readonly CleanupDue[]): string | undefined {
  const key = job.source?.key;
  const earlier = key === undefined ? undefined : due.find((d) => d.sourceKey === key && d.jobId !== job.id);
  if (!earlier) return undefined;
  return earlier.error === undefined
    ? `job ${earlier.jobId} of this item is being cleaned up`
    : `job ${earlier.jobId} of this item may still run: its cleanup waits for its machine (${earlier.error})`;
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

/** The most lanes jobs not pinned to it may hold: its lane cap less its reserved lanes (issue #372). */
export const unpinnedCap = (s: MachineState): number => Math.max(0, s.cap - (s.machine.reservedLanes ?? 0));

/**
 * Room for `job` there: a job not pinned to it also stays out of its reserved lanes, and a job that may not use a
 * priority lane leaves the free ones (issue #535).
 */
function roomForJob(s: MachineState, job: Job, pl?: PriorityLanesInput): number {
  const r = roomFor(s, job.spec.executor) - keptFor(s.slots, job, pl);
  return pinOf(job) === s.machine.id ? r : Math.min(r, unpinnedCap(s) - s.unpinned);
}

/** Whether an open problem names this machine, or every machine, and the job's executor (or none). */
const problemHits = (b: ProblemBlock, machineId: string, job: Job): boolean =>
  (b.machineId === undefined || b.machineId === machineId) && (b.executor === undefined || b.executor === job.spec.executor);

/** A job resuming returns to the pane it holds: no problem keeps it from it. */
const problemFree = (s: MachineState, job: Job): boolean => job.pendingAnswer !== undefined || !(s.problems ?? []).some((b) => problemHits(b, s.machine.id, job));

/**
 * Issue #509: the hold of a job an open problem keeps from every machine it may run on — its pinned one, or every
 * online machine of its executor —, naming the problem; undefined when one is free of them, or it resumes.
 */
export function problemHold(job: Job, machines: MachineSnapshot[], problems: readonly ProblemBlock[]): string | undefined {
  if (problems.length === 0 || job.pendingAnswer !== undefined) return undefined;
  const pin = pinOf(job);
  const places = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && (pin === undefined || m.id === pin));
  const blocking = places.map((m) => problems.find((b) => problemHits(b, m.id, job)));
  if (places.length === 0 || blocking.some((b) => b === undefined)) return undefined;
  return `held by problem: ${blocking[0]!.title}`;
}

function eligible(s: MachineState, job: Job): boolean {
  const pin = pinOf(job);
  return problemFree(s, job) && s.machine.online && !homeless(s.machine) && s.machine.executors.includes(job.spec.executor) && !diskHolds(s.machine, job)
    && !workTreeHolds(s.machine, job)
    && (pin === undefined || pin === s.machine.id);
}

const fits = (s: MachineState, job: Job, pl?: PriorityLanesInput): boolean => eligible(s, job) && roomForJob(s, job, pl) > 0;

/**
 * Where a critical job that fits nowhere may take a lane past its caps (issue #373): an eligible
 * machine not at its hard limit, for the machine or the job's executor, and not over its cap already —
 * so at most one lane over it.
 */
function squeezes(s: MachineState, job: Job): boolean {
  const e = s.executors.get(job.spec.executor);
  return eligible(s, job) && e !== undefined && s.band !== 'hard' && e.band !== 'hard'
    && s.occupied + s.assigned <= s.cap;
}

/** Of two machines, the better pick for `job`: most placement pressure, then most room, then lowest id. */
function better(a: MachineState, b: MachineState, job: Job, pl?: PriorityLanesInput): MachineState {
  const pa = a.executors.get(job.spec.executor)!.pressure;
  const pb = b.executors.get(job.spec.executor)!.pressure;
  if (pa !== pb) return pb > pa ? b : a;
  const ra = roomForJob(a, job, pl);
  const rb = roomForJob(b, job, pl);
  if (ra !== rb) return rb > ra ? b : a;
  return b.machine.id < a.machine.id ? b : a;
}

const percent = (frac: number): string => `${Math.round(frac * 100)}%`;
const usageNote = (band: CapBand, usedFrac: number): string => (band === 'soft' ? ` (usage soft limit, used ${percent(usedFrac)})` : '');

/**
 * Why a job waits for a lane (issue #381): the lane cap that binds on the machine with the most of
 * them — its executor's when that leaves less room than the machine's, else the machine's — with its
 * real number and how many lanes it counts in use.
 */
function waitReason(job: Job, states: MachineState[], pl?: PriorityLanesInput): string {
  const ex = job.spec.executor;
  const s = states.filter((m) => eligible(m, job)).reduce((a, b) => (b.executors.get(ex)!.cap > a.executors.get(ex)!.cap ? b : a));
  const e = s.executors.get(ex)!;
  const id = s.machine.id;
  if (e.band === 'hard') return `waiting for a lane: usage hard limit stops executor ${ex} on ${id} (used ${percent(e.usedFrac)})`;
  const kept = keptFor(s.slots, job, pl) > 0 ? freePriority(s.slots) : [];
  if (roomFor(s, ex) > 0 && kept.length > 0 && (pinOf(job) === id || s.unpinned < unpinnedCap(s))) {
    // Only its priority lanes are free (issue #535).
    return `waiting for a lane: machine ${id} keeps ${priorityLaneNames(kept)} free for high-priority jobs, the other ${s.occupied + s.assigned} are in use`;
  }
  if (roomFor(s, ex) > 0) {
    // Only its reserved lanes are free (issue #372).
    return `waiting for a lane: machine ${id} keeps ${s.cap - unpinnedCap(s)} of its ${s.cap} lanes for jobs pinned to it, the other ${s.unpinned} are in use`;
  }
  const executorInUse = e.occupied.length + e.assigned;
  const executorBinds = e.cap - executorInUse < room(s) || (e.cap - executorInUse === room(s) && e.cap < s.cap);
  if (executorBinds) {
    return `waiting for a lane: executor ${ex}'s lane cap on ${id} is ${e.cap}${usageNote(e.band, e.usedFrac)}, all ${executorInUse} in use`;
  }
  return `waiting for a lane: machine ${id}'s lane cap is ${s.cap}${usageNote(s.band, s.usedFrac)}, all ${s.occupied + s.assigned} in use`;
}

/**
 * Step 7: give each ordered job a machine and an idle lane, or leave it waiting for one. A high-priority job goes
 * to the machine holding the best free priority lane first (issue #535).
 */
export function assign(ordered: Candidate[], states: MachineState[], policy: DeciderPolicy, pl?: PriorityLanesInput): { start: StartPlan[]; wait: WaitPlan[] } {
  const start: StartPlan[] = [];
  const wait: WaitPlan[] = [];
  const critical = policy.pacing?.criticalPriority ?? 0;
  for (const { job, effectivePriority, note } of ordered) {
    const ex = job.spec.executor;
    const fitting = states.filter((s) => fits(s, job, pl));
    // A critical job that fits nowhere takes one lane over the cap (issue #373); the extra lane drains when it ends.
    const squeezed = fitting.length === 0 && critical > 0 && job.priority >= critical;
    const options = squeezed ? states.filter((s) => squeezes(s, job)) : fitting;
    if (options.length === 0) {
      wait.push({ jobId: job.id, reason: waitReason(job, states, pl) });
      continue;
    }
    const pick = (pl && isHigh(job, pl) ? holdingBestFree(options, pl) : undefined) ?? options.reduce((a, b) => better(a, b, job, pl));
    const pressure = pick.executors.get(ex)!.pressure;
    const picked = pickLane(pick.machine.id, pick.machine.maxLanes, pick.slots, pick.freeIdle, job, pl);
    const lane = picked ? picked.lane : pick.freeIdle.shift();
    pick.assigned += 1;
    if (pinOf(job) !== pick.machine.id) pick.unpinned += 1;
    const overCap = squeezed && pick.occupied + pick.assigned > pick.cap;
    if (overCap) pick.overCap += 1;
    pick.executors.get(ex)!.assigned += 1;
    const why = [
      ...(overCap ? [`critical priority: one lane over the cap ${pick.cap}`]
        : squeezed ? [`critical priority: past the executor's lane cap or the reserved lanes (cap ${pick.cap})`]
          : [`${room(pick)} room left (cap ${pick.cap})`]),
      ...(pressure > 0 ? [`placement pressure ${pressure.toFixed(3)}/h`] : []),
      ...(note ? [note] : []),
    ];
    const where = `${picked?.priority ? `priority lane ${picked.priority} ` : ''}${lane ? `${picked?.priority ? '(idle)' : `idle lane ${lane.id}`}` : picked?.priority ? '(new)' : 'new lane'}`;
    start.push({
      jobId: job.id, laneId: lane?.id ?? null, ...(picked?.opens ? { opens: picked.opens } : {}), machineId: pick.machine.id, effectivePriority,
      reason: `${where} on ${pick.machine.id}, ${why.join(', ')}`,
    });
  }
  return { start, wait };
}
