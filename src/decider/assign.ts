import type { BlastRadiusInput, CleanupDue, DeciderPolicy, ExecutorUnavailable, ExpectedCost, Job, JobId, Lane, MachineSnapshot, PlacementPick, PriorityLanesInput, ProblemBlock, SignedOutTool, StartPlan, WaitPlan } from '../domain/types.ts';
import { freePriority, holdingBestFree, isHigh, keptFor, pickLane, priorityLaneNames, type LaneSlots } from './priority-lanes.ts';
import { gateHold, gateKeeps } from './gate.ts';
import { elbowsInAs } from '../domain/elbow-in.ts';
import { isWindowsJob, windowsFits } from '../domain/windows-jobs.ts';
import { roomToElbowIn } from './elbow-in.ts';
import { routerVerdict } from './router-verdict.ts';
import type { CapBand } from './usage.ts';
import { fitting, place, type PlacedCost } from './placement-cost.ts';
import { jevPicked } from './lane-calls.ts';
import { SIGN_IN, signedOutFor } from './signed-out.ts';

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
  /** What the jobs this Decision placed here are expected to cost (issue #688). */
  placed: PlacedCost;
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
 * holds. Low is judged by the machine's own thresholds (src/machines/disk.ts).
 */
export const diskHolds = (m: MachineSnapshot, job: Job): boolean => m.disk?.low === true && job.pendingAnswer === undefined;

/**
 * A machine whose work tree cannot be made usable takes no new job (issue #361): the job waits for one
 * that can, never fails there. A job resuming there returns to the pane it holds.
 */
export const workTreeHolds = (m: MachineSnapshot, job: Job): boolean => m.workTreeProblem !== undefined && job.pendingAnswer === undefined;

/**
 * A machine whose jobs cannot reach the hopper takes no new job (issue #698): they would have no GitHub proxy and no
 * git. The job waits for a machine that reaches it, never fails there. A job resuming there returns to the pane it holds.
 */
export const addressHolds = (m: MachineSnapshot, job: Job): boolean => m.addressProblem !== undefined && job.pendingAnswer === undefined;

/**
 * A machine whose herdr client its herdr server does not take takes no new job (issue #741): every job start there
 * would fail. The job waits for a machine whose herdr works, never fails there. A job resuming there returns to the pane it holds.
 */
export const herdrHolds = (m: MachineSnapshot, job: Job): boolean => m.herdrProblem !== undefined && job.pendingAnswer === undefined;

/**
 * A machine whose job user holds credentials a job could use (issue #1248: a kube config, cloud CLI credentials, an ssh key,
 * a token variable) is not ready and takes no new job: a job holds no owner credentials (#652). The job waits for a ready
 * machine, never fails there; the machine takes jobs again once its probe finds none. A job resuming there returns to the pane it holds.
 * Unless the admin accepted it (issue #1459): then it takes jobs despite the credentials.
 */
export const credentialHolds = (m: MachineSnapshot, job: Job, accepted: boolean): boolean => !accepted && (m.infraCredentials?.length ?? 0) > 0 && job.pendingAnswer === undefined;

/** Why such a machine holds a job (issue #1248): what its job user holds, and the fix. */
const notReady = (m: MachineSnapshot): string =>
  `is not ready: its job user holds credentials a job could use (${m.infraCredentials!.join(', ')}). Run its jobs as a dedicated user that holds none`;

/** Why such a machine holds a job (issue #711): it is off-network, why, and the command that joins it when one fits. */
const offNetwork = (m: MachineSnapshot): string => `is off-network: ${m.addressProblem}${m.addressFix ? `. Fix: ${m.addressFix}` : ''}`;

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

const GIB = 1024 ** 3;
const freeOf = (m: MachineSnapshot): string => `${Math.round((m.disk!.freeBytes / GIB) * 10) / 10} GiB free`;
export const NO_NEW_JOB = 'no new job is claimed there';

/**
 * Step 5: a hold that applies regardless of the router, or undefined. An unavailable executor
 * comes first: its reason says what to fix.
 */
export function nativeHold(job: Job, machines: MachineSnapshot[], unavailable: ExecutorUnavailable[], signedOut?: readonly SignedOutTool[], credentialAcceptances?: ReadonlySet<string>): string | undefined {
  const executor = job.spec.executor;
  const down = unavailable.find((u) => u.name === executor);
  if (down) return `executor ${executor} unavailable: ${down.reason}`;
  const pin = pinOf(job);
  const running = machines.filter((m) => m.online && m.executors.includes(executor));
  if (running.length === 0) return `no online machine runs executor ${executor}`;
  if (pin === undefined) {
    const staying = running.filter((m) => !leavingHolds(m, job));
    if (staying.length === 0) return `${running.map((m) => m.id).join(', ')} ${running.length > 1 ? 'are' : 'is'} leaving: ${NO_NEW_JOB}`;
    const known = staying.filter((m) => !homeless(m));
    if (known.length === 0) {
      return `no machine that runs executor ${executor} has its home known yet: ${staying.map((m) => m.id).join(', ')} ${staying.length > 1 ? 'have' : 'has'} not answered a probe`;
    }
    if (known.every((m) => workTreeHolds(m, job))) {
      return `no machine running executor ${executor} has a usable work tree: ${known.map((m) => `${m.id}: ${m.workTreeProblem}`).join('; ')}`;
    }
    const tree = known.filter((m) => !workTreeHolds(m, job));
    if (tree.every((m) => addressHolds(m, job))) {
      return `no machine running executor ${executor} reaches the hopper: ${tree.map((m) => `${m.id} ${offNetwork(m)}`).join('; ')}`;
    }
    const reached = tree.filter((m) => !addressHolds(m, job));
    if (reached.every((m) => credentialHolds(m, job, credentialAcceptances?.has(m.id) ?? false))) {
      return `no machine running executor ${executor} is ready: ${reached.map((m) => `${m.id} ${notReady(m)}`).join('; ')}`;
    }
    const reaching = reached.filter((m) => !credentialHolds(m, job, credentialAcceptances?.has(m.id) ?? false));
    if (reaching.every((m) => herdrHolds(m, job))) {
      return `no machine running executor ${executor} has a working herdr: ${reaching.map((m) => `${m.id}: ${m.herdrProblem}`).join('; ')}`;
    }
    const working = reaching.filter((m) => !herdrHolds(m, job));
    if (working.every((m) => templateHolds(m, job))) return `${working.map((m) => `${m.id}: ${m.template!.waiting}`).join('; ')}: ${NO_NEW_JOB}`;
    const usable = working.filter((m) => !templateHolds(m, job));
    if (usable.every((m) => diskHolds(m, job))) return `disk low on ${usable.map((m) => `${m.id} (${freeOf(m)})`).join(', ')}: ${NO_NEW_JOB}`;
    const roomy = usable.filter((m) => !diskHolds(m, job));
    const out = roomy.map((m) => signedOutFor(m.id, job, signedOut));
    if (out.every((t) => t !== undefined)) {
      return `no machine running executor ${executor} is signed in: ${roomy.map((m, i) => `${m.id} (${out[i]!.service} signed out)`).join(', ')}: ${SIGN_IN}`;
    }
    return undefined;
  }
  const pinned = machines.find((m) => m.id === pin);
  if (!pinned) return `pinned machine ${pin} unknown`;
  if (!pinned.online) return `pinned machine ${pin} offline`;
  if (!pinned.executors.includes(executor)) return `pinned machine ${pin} does not run executor ${executor}`;
  if (leavingHolds(pinned, job)) return `pinned machine ${pin} is leaving: ${NO_NEW_JOB}`;
  if (homeless(pinned)) return `pinned machine ${pin}: its home is not known yet (it has not answered a probe)`;
  if (workTreeHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.workTreeProblem}`;
  if (addressHolds(pinned, job)) return `pinned machine ${pin} ${offNetwork(pinned)}`;
  if (credentialHolds(pinned, job, credentialAcceptances?.has(pinned.id) ?? false)) return `pinned machine ${pin} ${notReady(pinned)}`;
  if (herdrHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.herdrProblem}`;
  if (templateHolds(pinned, job)) return `pinned machine ${pin}: ${pinned.template!.waiting}`;
  if (diskHolds(pinned, job)) return `pinned machine ${pin} disk low (${freeOf(pinned)}): ${NO_NEW_JOB}`;
  const out = signedOutFor(pin, job, signedOut);
  if (out) return `pinned machine ${pin}: ${out.service} signed out (usage source ${out.source}): ${SIGN_IN}`;
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
  const places = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && windowsFits(m, job) && (pin === undefined || m.id === pin));
  const blocking = places.map((m) => problems.find((b) => problemHits(b, m.id, job)));
  if (places.length === 0 || blocking.some((b) => b === undefined)) return undefined;
  return `held by problem: ${blocking[0]!.title}`;
}

/**
 * Issue #542: the hold of a job the blast-radius gate keeps from every machine it could otherwise take a new job on,
 * naming them; undefined when one is not gated for it, or it resumes.
 */
export function bringsToGate(job: Job, machines: MachineSnapshot[], problems: readonly ProblemBlock[], gate: BlastRadiusInput | undefined, signedOut?: readonly SignedOutTool[], credentialAcceptances?: ReadonlySet<string>): string | undefined {
  if (!gate || job.pendingAnswer !== undefined) return undefined;
  const pin = pinOf(job);
  const usable = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && windowsFits(m, job) && (pin === undefined || m.id === pin)
    && !homeless(m) && !leavingHolds(m, job) && !workTreeHolds(m, job) && !addressHolds(m, job) && !credentialHolds(m, job, credentialAcceptances?.has(m.id) ?? false) && !herdrHolds(m, job) && !templateHolds(m, job) && !diskHolds(m, job) && !problems.some((b) => problemHits(b, m.id, job))
    && signedOutFor(m.id, job, signedOut) === undefined);
  return gateHold(job, usable, gate);
}

/** State extended with acceptances for checking `credentialHolds`. */
interface MachineStateWithAcceptances extends MachineState {
  credentialAccepted: boolean;
}

function eligible(s: MachineStateWithAcceptances, job: Job): boolean {
  const pin = pinOf(job);
  return problemFree(s, job) && windowsFits(s.machine, job) && gateKeeps(s.machine.id, job, s.gate) === undefined && s.machine.online && !homeless(s.machine) && !leavingHolds(s.machine, job) && s.machine.executors.includes(job.spec.executor) && !diskHolds(s.machine, job)
    && !workTreeHolds(s.machine, job) && !addressHolds(s.machine, job) && !credentialHolds(s.machine, job, s.credentialAccepted) && !herdrHolds(s.machine, job) && !templateHolds(s.machine, job)
    && signedOutFor(s.machine.id, job, s.signedOut) === undefined && (pin === undefined || pin === s.machine.id);
}

/**
 * Issue #788: before `job` is placed, each machine holds a priority lane for every high-priority job after it in the
 * order that could run there; none once they are placed.
 */
function holdFor(states: MachineStateWithAcceptances[], ahead: Job[], job: Job): void {
  if (ahead[0] === job) ahead.shift();
  for (const s of states) s.slots.wanted = ahead.filter((h) => eligible(s, h) && roomFor(s, h.spec.executor) > 0).length;
}

const fitsLane = (s: MachineStateWithAcceptances, job: Job, pl?: PriorityLanesInput): boolean => eligible(s, job) && roomForJob(s, job, pl) > 0;

/**
 * Where a critical job that fits nowhere may take a lane past its caps (issue #373): an eligible
 * machine not at its hard limit, for the machine or the job's executor, and not over its cap already —
 * so at most one lane over it.
 */
function squeezes(s: MachineStateWithAcceptances, job: Job): boolean {
  const e = s.executors.get(job.spec.executor);
  return eligible(s, job) && e !== undefined && s.band !== 'hard' && e.band !== 'hard'
    && s.occupied + s.assigned <= s.cap;
}

/** Where a specialty or tend job that fits nowhere may elbow in past the caps (issues #762, #967): an eligible machine with room to. */
function elbowsIn(s: MachineStateWithAcceptances, job: Job): boolean {
  const e = s.executors.get(job.spec.executor);
  return eligible(s, job) && e !== undefined && roomToElbowIn(s, e.band);
}

/** Of two machines, the better pick for `job`: most placement pressure, then most room, then lowest id. */
function better(a: MachineStateWithAcceptances, b: MachineStateWithAcceptances, job: Job, pl?: PriorityLanesInput): MachineStateWithAcceptances {
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
function waitReason(job: Job, states: MachineStateWithAcceptances[], pl?: PriorityLanesInput): string {
  const ex = job.spec.executor;
  const able = states.filter((m) => eligible(m, job));
  if (able.length === 0 && isWindowsJob(job)) return windowsWait(job, states.map((s) => s.machine));
  const s = able.reduce((a, b) => (b.executors.get(ex)!.cap > a.executors.get(ex)!.cap ? b : a));
  const e = s.executors.get(ex)!;
  const id = s.machine.id;
  if (e.band === 'hard') return `waiting for a lane: usage hard limit stops executor ${ex} on ${id} (used ${percent(e.usedFrac)})`;
  const kept = keptFor(s.slots, job, pl) > 0 ? freePriority(s.slots) : [];
  if (roomFor(s, ex) > 0 && kept.length > 0 && (pinOf(job) === id || s.unpinned < unpinnedCap(s))) {
    // Only priority lanes held for high-priority jobs still to be placed are free (issues #535, #788).
    return `waiting for a lane: machine ${id} holds ${priorityLaneNames(kept)} for high-priority jobs still to be placed, the other ${s.occupied + s.assigned} are in use`;
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
 * Why a Windows job no Windows machine can take waits (issue #1350): none runs its executor, none of those is online, or
 * none of those takes it now (pinned elsewhere, or held there). It waits queued; it never goes to another machine.
 */
function windowsWait(job: Job, states: MachineState[]): string {
  const ex = job.spec.executor;
  const runs = states.map((s) => s.machine).filter((m) => m.windows === true && m.executors.includes(ex));
  if (runs.length === 0) return `waiting for a Windows lane: no Windows machine runs executor ${ex}`;
  const online = runs.filter((m) => m.online);
  if (online.length === 0) return `waiting for a Windows lane: no Windows machine that runs executor ${ex} is online (${runs.map((m) => `${m.id} offline`).join(', ')})`;
  const pin = pinOf(job);
  if (pin !== undefined && !online.some((m) => m.id === pin)) return `waiting for a Windows lane: it is pinned to ${pin}, which is not an online Windows machine`;
  return `waiting for a Windows lane: no Windows machine that runs executor ${ex} takes a new job now (${online.map((m) => m.id).join(', ')})`;
}

/**
 * Step 7: give each ordered job a machine and an idle lane, or leave it waiting for one. A high-priority job goes
 * to the machine holding the best free priority lane first (issue #535). Of the machines it may go to, one where its expected
 * cost fits goes first, and of those Jev's applied pick of its machine (issue #688).
 */
export function assign(ordered: Candidate[], states: MachineState[], policy: DeciderPolicy, pl?: PriorityLanesInput, costs?: Record<JobId, ExpectedCost>, picks?: Record<JobId, PlacementPick>, credentialAcceptances?: ReadonlySet<string>): { start: StartPlan[]; wait: WaitPlan[] } {
  const start: StartPlan[] = [];
  const wait: WaitPlan[] = [];
  const critical = policy.pacing?.criticalPriority ?? 0;
  const ahead = pl ? ordered.map((c) => c.job).filter((j) => isHigh(j, pl)) : [];
  // Extend states with acceptance information
  const statesWithAcceptances: MachineStateWithAcceptances[] = states.map((s) => ({
    ...s,
    credentialAccepted: credentialAcceptances?.has(s.machine.id) ?? false,
  }));
  for (const { job, effectivePriority, note } of ordered) {
    const ex = job.spec.executor;
    holdFor(statesWithAcceptances, ahead, job);
    const fits = statesWithAcceptances.filter((s) => fitsLane(s, job, pl));
    // A specialty or tend job that fits nowhere elbows in past the cap (issues #762, #967); else a critical one takes one
    // lane over it (issue #373). The extra lane drains when its job ends.
    const as = elbowsInAs(job);
    const elbowing = fits.length === 0 && as ? statesWithAcceptances.filter((s) => elbowsIn(s, job)) : [];
    const elbowed = elbowing.length > 0;
    const squeezed = fits.length === 0 && !elbowed && critical > 0 && job.priority >= critical;
    const able = elbowed ? elbowing : squeezed ? statesWithAcceptances.filter((s) => squeezes(s, job)) : fits;
    if (able.length === 0) {
      wait.push({ jobId: job.id, reason: waitReason(job, statesWithAcceptances, pl) });
      continue;
    }
    const { options: fit, note: costed } = fitting(able, costs?.[job.id]);
    const { options, note: jev } = jevPicked(fit, picks?.[job.id]);
    const pick = (pl && isHigh(job, pl) ? holdingBestFree(options, pl) : undefined) ?? options.reduce((a, b) => better(a, b, job, pl));
    const pressure = pick.executors.get(ex)!.pressure;
    const picked = pickLane(pick.machine.id, pick.machine.maxLanes, pick.slots, pick.freeIdle, job, pl);
    const lane = picked ? picked.lane : pick.freeIdle.shift();
    pick.assigned += 1;
    if (pinOf(job) !== pick.machine.id) pick.unpinned += 1;
    const overCap = (squeezed || elbowed) && pick.occupied + pick.assigned > pick.cap;
    if (overCap) pick.overCap += 1;
    pick.executors.get(ex)!.assigned += 1;
    place(pick.placed, costs?.[job.id]);
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
