import type { BlastRadiusInput, CleanupDue, DeciderPolicy, ExecutorUnavailable, ExpectedCost, Job, JobId, Lane, LaneId, MachineSnapshot, PlacementPick, PriorityLanesInput, ProblemBlock, SignedOutTool, StartPlan, WaitPlan } from '../domain/types.ts';
import { holdingBestFree, isHigh, keptFor, pickLane, type LaneSlots } from './priority-lanes.ts';
import { gateHold, gateKeeps } from './gate.ts';
import { elbowsInAs } from '../domain/elbow-in.ts';
import { windowsFits } from '../domain/windows-jobs.ts';
import { roomToElbowIn } from './elbow-in.ts'; import { awayFrom, takeIdle } from './lane-health.ts';
import { routerVerdict } from './router-verdict.ts';
import type { CapBand } from './usage.ts';
import { fitting, place, type PlacedCost } from './placement-cost.ts'; import { keepMemory, memoryAdmits, memoryHeadroom, memoryLanes, type MemoryRoom } from './memory-floor.ts'; import { cpuThrottled } from './cpu-throttle.ts';
import { jevPicked } from './lane-calls.ts'; import { roomWait, waitReason } from './wait-reason.ts';
import { SIGN_IN, signedOutFor } from './signed-out.ts';
import { addressHolds, credentialHolds, heldOff, herdrHolds, notReady, offNetwork, opensPane, workTreeHolds } from './machine-holds.ts';

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
  /** Lanes over the cap this Decision gave critical jobs (at most 1, issue #373) or jobs that elbow in (issues #762, #967). */
  overCap: number;
  /** Lanes busy or draining, and starts, of jobs not pinned to it (issue #372). */
  unpinned: number;
  /** Per executor the machine runs (issue #140). */
  executors: Map<string, ExecutorState>;
  /** Open problems on this machine (issue #509): a new job of an executor one names is placed elsewhere. */
  problems?: ProblemBlock[];
  /** Its priority lanes and which of its lanes are open or in use (issue #535). */
  slots: LaneSlots;
  /** The blast-radius gate (issue #542): a job it keeps from this machine is placed elsewhere. */
  gate?: BlastRadiusInput;
  /** What the jobs this Decision placed here are expected to cost (issue #688). `memory`: its memory room (issue #2291); absent: no reading, or its floor off. */
  placed: PlacedCost; memory?: MemoryRoom;
  /** Its agent tools that read signed out (issue #1128 part 5): a new job of their executors is placed elsewhere. */
  signedOut?: SignedOutTool[];
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
 * holds. One whose disk is critical takes no job at all (issue #2494): a job resuming there waits too. Both are judged by
 * the machine's own thresholds (src/machines/disk.ts).
 */
export const diskHolds = (m: MachineSnapshot, job: Job): boolean => m.disk?.critical === true || (m.disk?.low === true && job.pendingAnswer === undefined);

/** How a disk that holds jobs is named: low, or critical (issue #2494). */
export const diskWord = (m: MachineSnapshot): string => (m.disk?.critical ? 'critical' : 'low');

/**
 * A sandbox box whose template is not approved takes no new job (issue #602): the job waits for a machine that can
 * take it, never fails there. A job resuming there returns to the pane it holds.
 */
export const templateHolds = (m: MachineSnapshot, job: Job): boolean => m.template?.waiting !== undefined && job.pendingAnswer === undefined;

/**
 * A machine that is leaving takes no new job (issue #1284): a lane pod told to stop lets the jobs on it end. A job
 * resuming there returns to the pane it holds.
 */
export const leavingHolds = (m: MachineSnapshot, job: Job): boolean => m.leaving === true && job.pendingAnswer === undefined;

/**
 * A machine a person drained takes no new job (issue #1511): the jobs on it run to their end. A job resuming there
 * returns to the pane it holds; one that resumes elsewhere opens a new one, so it is held too (issue #2355).
 */
export const drainedHolds = (m: MachineSnapshot, job: Job): boolean => m.drained !== undefined && opensPane(job);

/**
 * A client target that holds jobs off to be updated (issue #2715, src/machines/client-release.ts) takes no job, new or
 * back to its pane: the jobs at work there end, its client is loaded with the hopper's release, and it takes jobs again.
 */
export const updateHolds = (m: MachineSnapshot): boolean => m.client?.updateHold !== undefined;

/** A job moved off a lost machine (issue #1569) does not go back to it while the agent it left there may run. */
export const leftHolds = (m: MachineSnapshot, job: Job): boolean => job.parked?.elsewhere?.lost === true && job.parked.elsewhere.from === m.id;

const GIB = 1024 ** 3;
export const freeOf = (m: MachineSnapshot): string => `${Math.round((m.disk!.freeBytes / GIB) * 10) / 10} GiB free`;
export const NO_NEW_JOB = 'no new job is claimed there';

/**
 * Step 5: a hold that applies regardless of the router, or undefined. An unavailable executor
 * comes first: its reason says what to fix.
 */
export function nativeHold(job: Job, machines: MachineSnapshot[], unavailable: ExecutorUnavailable[], signedOut?: readonly SignedOutTool[], credentialHeld?: readonly string[]): string | undefined {
  const executor = job.spec.executor;
  const down = unavailable.find((u) => u.name === executor);
  if (down) return `executor ${executor} unavailable: ${down.reason}`;
  const pin = pinOf(job);
  const running = machines.filter((m) => m.online && m.executors.includes(executor));
  if (running.length === 0) return `no online machine runs executor ${executor}`;
  if (pin === undefined) {
    const staying = running.filter((m) => !leavingHolds(m, job));
    if (staying.length === 0) return `${running.map((m) => m.id).join(', ')} ${running.length > 1 ? 'are' : 'is'} leaving: ${NO_NEW_JOB}`;
    const undrained = staying.filter((m) => !drainedHolds(m, job));
    if (undrained.length === 0) return `${staying.map((m) => m.id).join(', ')} ${staying.length > 1 ? 'are' : 'is'} drained: ${NO_NEW_JOB}`;
    const current = undrained.filter((m) => !updateHolds(m));
    if (current.length === 0) return `${undrained.map((m) => m.id).join(', ')} ${undrained.length > 1 ? 'hold' : 'holds'} jobs off until ${undrained.length > 1 ? 'their clients are' : 'its client is'} updated: ${NO_NEW_JOB}`;
    const open = current.filter((m) => !leftHolds(m, job));
    if (open.length === 0) return `it moved off ${job.parked!.elsewhere!.from} when that machine was lost: it waits for another machine, or for the agent it left there to end`;
    const known = open.filter((m) => !homeless(m));
    if (known.length === 0) {
      return `no machine that runs executor ${executor} has its home known yet: ${open.map((m) => m.id).join(', ')} ${open.length > 1 ? 'have' : 'has'} not answered a probe`;
    }
    if (known.every((m) => workTreeHolds(m, job))) {
      return `no machine running executor ${executor} has a usable work tree: ${known.map((m) => `${m.id}: ${m.workTreeProblem}`).join('; ')}`;
    }
    const tree = known.filter((m) => !workTreeHolds(m, job));
    if (tree.every((m) => addressHolds(m, job))) {
      return `no machine running executor ${executor} reaches the hopper: ${tree.map((m) => `${m.id} ${offNetwork(m)}`).join('; ')}`;
    }
    const reached = tree.filter((m) => !addressHolds(m, job));
    const reason = reachedHold(job, reached, signedOut, credentialHeld);
    return reason === undefined ? undefined : `${reason}${heldOff(tree, job)}`;
  }
  const pinned = machines.find((m) => m.id === pin);
  if (!pinned) return `pinned machine ${pin} unknown`;
  if (!pinned.online) return `pinned machine ${pin} offline`;
  if (!pinned.executors.includes(executor)) return `pinned machine ${pin} does not run executor ${executor}`;
  if (leavingHolds(pinned, job)) return `pinned machine ${pin} is leaving: ${NO_NEW_JOB}`;
  if (drainedHolds(pinned, job)) return `pinned machine ${pin} is drained: ${NO_NEW_JOB}`;
  if (updateHolds(pinned)) return `pinned machine ${pin} holds jobs off until its client is updated: ${NO_NEW_JOB}`;
  if (homeless(pinned)) return `pinned machine ${pin}: its home is not known yet (it has not answered a probe)`;
  if (workTreeHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.workTreeProblem}`;
  if (addressHolds(pinned, job)) return `pinned machine ${pin} ${offNetwork(pinned)}`;
  if (credentialHolds(pinned, job, credentialHeld?.includes(pinned.id) ?? false)) return `pinned machine ${pin} ${notReady(pinned)}`;
  if (herdrHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.herdrProblem}`;
  if (templateHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.template!.waiting}`;
  if (diskHolds(pinned, job)) return `pinned machine ${pin} disk ${diskWord(pinned)} (${freeOf(pinned)}): ${NO_NEW_JOB}`;
  const out = signedOutFor(pin, job, signedOut);
  if (out) return `pinned machine ${pin}: ${out.service} signed out (usage source ${out.source}): ${SIGN_IN}`;
  return undefined;
}

/** Why a job no machine that reaches the hopper takes is held (step 5 after the reach step), or undefined. */
function reachedHold(job: Job, reached: MachineSnapshot[], signedOut?: readonly SignedOutTool[], credentialHeld?: readonly string[]): string | undefined {
  const executor = job.spec.executor;
  if (reached.every((m) => credentialHolds(m, job, credentialHeld?.includes(m.id) ?? false))) {
    return `no machine running executor ${executor} is ready: ${reached.map((m) => `${m.id} ${notReady(m)}`).join('; ')}`;
  }
  const reaching = reached.filter((m) => !credentialHolds(m, job, credentialHeld?.includes(m.id) ?? false));
  if (reaching.every((m) => herdrHolds(m, job))) {
    return `no machine running executor ${executor} has a working herdr: ${reaching.map((m) => `${m.id}: ${m.herdrProblem}`).join('; ')}`;
  }
  const working = reaching.filter((m) => !herdrHolds(m, job));
  if (working.every((m) => templateHolds(m, job))) return `${working.map((m) => `${m.id}: ${m.template!.waiting}`).join('; ')}: ${NO_NEW_JOB}`;
  const usable = working.filter((m) => !templateHolds(m, job));
  if (usable.every((m) => diskHolds(m, job))) return `disk ${usable.every((m) => m.disk?.critical) ? 'critical' : 'low'} on ${usable.map((m) => `${m.id} (${freeOf(m)})`).join(', ')}: ${NO_NEW_JOB}`;
  const roomy = usable.filter((m) => !diskHolds(m, job));
  const out = roomy.map((m) => signedOutFor(m.id, job, signedOut));
  if (out.every((t) => t !== undefined)) {
    return `no machine running executor ${executor} is signed in: ${roomy.map((m, i) => `${m.id} (${out[i]!.service} signed out)`).join(', ')}: ${SIGN_IN}`;
  }
  return undefined;
}

/**
 * Issue #365: an ssh or client target whose probe has not found its home yet. `~` in a work tree cannot
 * resolve there, so no job is placed on it until it has; this machine's and a container target's need none.
 */
export const homeless = (m: MachineSnapshot): boolean => (m.ssh !== undefined || m.client !== undefined) && m.home === undefined;

/**
 * Issue #371: an ended job of the same item whose cleanup has not gone through may still run in its pane;
 * starting this one beside it runs the item twice. Held until that cleanup goes through, or a person marks it done
 * (issue #2427: the reason says how, for a machine that is gone for good).
 */
export function cleanupHold(job: Job, due: readonly CleanupDue[]): string | undefined {
  const key = job.source?.key;
  const earlier = key === undefined ? undefined : due.find((d) => d.sourceKey === key && d.jobId !== job.id);
  if (!earlier) return undefined;
  return earlier.error === undefined
    ? `job ${earlier.jobId} of this item is being cleaned up`
    : `job ${earlier.jobId} of this item may still run: its cleanup waits for its machine (${earlier.error}). `
      + `Its pane closed, or its machine gone for good: Mark closed on job ${earlier.jobId}, or hopper job cleaned-up ${earlier.jobId}`;
}

/**
 * A waiting job's effective priority: a resuming job's priority plus the resume boost; any other
 * job's priority plus the router's boost. The engine reads it for the queue sorter's input, so the
 * sorter and the decider agree on one notion.
 */
export function effectivePriority(job: Job, policy: DeciderPolicy): number {
  // A preempted job (issue #1525) waits at its own priority: a boost would take the lane back from the job that preempted it.
  if (job.preempted !== undefined) return job.priority;
  if (job.pendingAnswer !== undefined) return job.priority + policy.resumeBoost;
  return job.priority + routerVerdict(job, policy.routerCheapBoost).boost;
}

/**
 * Step 6: by the queue order when there is one — the jobs it names first, in its order; the rest
 * after them — and otherwise (and among the rest) priority desc, a preempted job first (issue #1525), createdAt asc, id.
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
    || Number(b.job.preempted !== undefined) - Number(a.job.preempted !== undefined)
    || a.job.createdAt.localeCompare(b.job.createdAt)
    || a.job.id.localeCompare(b.job.id));
}

export function room(s: MachineState): number {
  return s.cap - s.occupied - s.assigned;
}

/** Room for one more job of `executor`: the machine's lanes, and the executor's own cap. */
export function roomFor(s: MachineState, executor: string): number {
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
export const problemHits = (b: ProblemBlock, machineId: string, job: Job): boolean =>
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
  const places = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && windowsFits(m, job) && (pin === undefined || m.id === pin));
  const blocking = places.map((m) => problems.find((b) => problemHits(b, m.id, job)));
  if (places.length === 0 || blocking.some((b) => b === undefined)) return undefined;
  return `held by problem: ${blocking[0]!.title}`;
}

/**
 * Issue #542: the hold of a job the blast-radius gate keeps from every machine it could otherwise take a new job on,
 * naming them; undefined when one is not gated for it, or it resumes.
 */
export function bringsToGate(job: Job, machines: MachineSnapshot[], problems: readonly ProblemBlock[], gate: BlastRadiusInput | undefined, signedOut?: readonly SignedOutTool[], credentialHeld?: readonly string[]): string | undefined {
  if (!gate || job.pendingAnswer !== undefined) return undefined;
  const pin = pinOf(job);
  const usable = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && windowsFits(m, job) && (pin === undefined || m.id === pin)
    && !homeless(m) && !leavingHolds(m, job) && !drainedHolds(m, job) && !updateHolds(m) && !workTreeHolds(m, job) && !addressHolds(m, job) && !credentialHolds(m, job, credentialHeld?.includes(m.id) ?? false) && !herdrHolds(m, job) && !templateHolds(m, job) && !diskHolds(m, job) && !problems.some((b) => problemHits(b, m.id, job))
    && signedOutFor(m.id, job, signedOut) === undefined);
  return gateHold(job, usable, gate);
}

/** State with whether the credential check holds the machine (`credentialHolds`, issue #1467). */
export interface MachineStateWithCredentialHold extends MachineState {
  credentialHeld: boolean;
}

export function eligible(s: MachineStateWithCredentialHold, job: Job): boolean {
  const pin = pinOf(job);
  return problemFree(s, job) && windowsFits(s.machine, job) && gateKeeps(s.machine.id, job, s.gate) === undefined && s.machine.online && !homeless(s.machine) && !leavingHolds(s.machine, job) && !drainedHolds(s.machine, job) && !updateHolds(s.machine) && !leftHolds(s.machine, job) && s.machine.executors.includes(job.spec.executor) && !diskHolds(s.machine, job)
    && !workTreeHolds(s.machine, job) && !addressHolds(s.machine, job) && !credentialHolds(s.machine, job, s.credentialHeld) && !herdrHolds(s.machine, job) && !templateHolds(s.machine, job)
    && signedOutFor(s.machine.id, job, s.signedOut) === undefined && (pin === undefined || pin === s.machine.id);
}

/**
 * Issue #788: before `job` is placed, each machine holds a priority lane for every high-priority job after it in the
 * order that could run there; none once they are placed.
 */
function holdFor(states: MachineStateWithCredentialHold[], ahead: Job[], job: Job): void {
  if (ahead[0] === job) ahead.shift();
  for (const s of states) s.slots.wanted = ahead.filter((h) => eligible(s, h) && roomFor(s, h.spec.executor) > 0).length;
}

export const fitsLane = (s: MachineStateWithCredentialHold, job: Job, pl?: PriorityLanesInput): boolean => eligible(s, job) && roomForJob(s, job, pl) > 0;


/**
 * Where a critical job that fits nowhere may take a lane past its caps (issue #373): an eligible
 * machine not at its hard limit, for the machine or the job's executor, and not over its cap already —
 * so at most one lane over it.
 */
function squeezes(s: MachineStateWithCredentialHold, job: Job): boolean {
  const e = s.executors.get(job.spec.executor);
  return eligible(s, job) && e !== undefined && s.band !== 'hard' && e.band !== 'hard'
    && s.occupied + s.assigned <= s.cap;
}

/** Where a specialty or tend job that fits nowhere may elbow in past the caps (issues #762, #967): an eligible machine with room to. */
function elbowsIn(s: MachineStateWithCredentialHold, job: Job): boolean {
  const e = s.executors.get(job.spec.executor);
  return eligible(s, job) && e !== undefined && roomToElbowIn(s, e.band);
}

/**
 * Of two machines, the better pick for `job`: most placement pressure, then most real room — its lane room, only as far as
 * its memory holds jobs —, then most memory over its floor (issue #2499), then most lane room, then lowest id. A machine
 * with no memory room counted (no reading, floor off) is judged by its lanes alone.
 */
function better(a: MachineStateWithCredentialHold, b: MachineStateWithCredentialHold, job: Job, pl?: PriorityLanesInput): MachineStateWithCredentialHold {
  const pa = a.executors.get(job.spec.executor)!.pressure;
  const pb = b.executors.get(job.spec.executor)!.pressure;
  if (pa !== pb) return pb > pa ? b : a;
  const ra = roomForJob(a, job, pl);
  const rb = roomForJob(b, job, pl);
  if (a.memory && b.memory) {
    const real = (s: MachineStateWithCredentialHold, r: number): number => Math.min(r, memoryLanes(s.memory!));
    if (real(a, ra) !== real(b, rb)) return real(b, rb) > real(a, ra) ? b : a;
    const ha = memoryHeadroom(a.memory);
    const hb = memoryHeadroom(b.memory);
    if (ha !== hb) return hb > ha ? b : a;
  }
  if (ra !== rb) return rb > ra ? b : a;
  return b.machine.id < a.machine.id ? b : a;
}

/**
 * Step 7: give each ordered job a machine and an idle lane, or leave it waiting for one. A high-priority job goes
 * to the machine holding the best free priority lane first (issue #535). Of the machines it may go to, one where its expected
 * cost fits goes first, and of those Jev's applied pick of its machine (issue #688).
 */
export function assign(ordered: Candidate[], states: MachineState[], policy: DeciderPolicy, pl?: PriorityLanesInput, costs?: Record<JobId, ExpectedCost>, picks?: Record<JobId, PlacementPick>, credentialHeld?: readonly string[], avoid: Record<JobId, LaneId> = {}): { start: StartPlan[]; wait: WaitPlan[] } {
  const start: StartPlan[] = [];
  const wait: WaitPlan[] = [];
  const critical = policy.pacing?.criticalPriority ?? 0;
  const ahead = pl ? ordered.map((c) => c.job).filter((j) => isHigh(j, pl)) : [];
  // The same state objects, not copies: placing a job counts its lane on them, and the lane plan reads them after.
  const checked: MachineStateWithCredentialHold[] = states.map((s) => Object.assign(s, { credentialHeld: credentialHeld?.includes(s.machine.id) ?? false }));
  for (const { job, effectivePriority, note } of ordered) {
    const ex = job.spec.executor;
    holdFor(checked, ahead, job);
    const fits = checked.filter((s) => fitsLane(s, job, pl));
    // A specialty or tend job that fits nowhere elbows in past the cap (issues #762, #967); else a critical one takes one
    // lane over it (issue #373). The extra lane drains when its job ends.
    const as = elbowsInAs(job);
    const elbowing = fits.length === 0 && as ? checked.filter((s) => elbowsIn(s, job)) : [];
    const elbowed = elbowing.length > 0;
    const squeezed = fits.length === 0 && !elbowed && critical > 0 && job.priority >= critical;
    const laned = elbowed ? elbowing : squeezed ? checked.filter((s) => squeezes(s, job)) : fits;
    // The memory floor (issue #2291): of the machines with a lane for it, only one whose memory holds it, and no CPU throttle (issue #2499).
    const able = laned.filter((s) => memoryAdmits(s.memory, costs?.[job.id]) && !cpuThrottled(s.machine));
    if (able.length === 0) {
      // Every other machine of its executor is named with why it was left out (issues #2427, #2499).
      wait.push({ jobId: job.id, reason: laned.length ? roomWait(job, checked, laned, pl, costs?.[job.id]) : waitReason(job, checked, pl, costs?.[job.id]) });
      continue;
    }
    const { options: fit, note: costed } = fitting(awayFrom(able, avoid[job.id]), costs?.[job.id]);
    const { options, note: jev } = jevPicked(fit, picks?.[job.id]);
    const pick = (pl && isHigh(job, pl) ? holdingBestFree(options, pl) : undefined) ?? options.reduce((a, b) => better(a, b, job, pl));
    const pressure = pick.executors.get(ex)!.pressure;
    const picked = pickLane(pick.machine.id, pick.machine.maxLanes, pick.slots, pick.freeIdle, job, pl);
    const lane = picked ? picked.lane : takeIdle(pick.freeIdle, avoid[job.id]);
    pick.assigned += 1;
    if (pinOf(job) !== pick.machine.id) pick.unpinned += 1;
    const overCap = (squeezed || elbowed) && pick.occupied + pick.assigned > pick.cap;
    if (overCap) pick.overCap += 1;
    pick.executors.get(ex)!.assigned += 1;
    place(pick.placed, costs?.[job.id]); keepMemory(pick.memory, costs?.[job.id]);
    const why = [
      ...(elbowed ? [overCap ? `${as}: elbows in over the lane cap ${pick.cap}` : `${as}: elbows in past the executor's lane cap or the reserved lanes (cap ${pick.cap})`]
        : overCap ? [`critical priority: one lane over the cap ${pick.cap}`]
        : squeezed ? [`critical priority: past the executor's lane cap or the reserved lanes (cap ${pick.cap})`]
          : [`${room(pick)} room left (cap ${pick.cap})`]),
      ...(pressure > 0 ? [`placement pressure ${pressure.toFixed(3)}/h`] : []),
      ...(costed ? [costed] : []),
      ...(jev ? [jev] : []),
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
