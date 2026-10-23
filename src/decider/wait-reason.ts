// Why a job waits for a lane (issues #381, #2499): the lane cap that binds on the machine with the most lanes for it, then
// every other machine that runs its executor and why it was left out — offline, leaving, drained, held, full, at a usage
// limit, short of memory —, so a drained or paced machine never hides behind the one named. Pure.
import type { ExpectedCost, Job, MachineSnapshot, PriorityLanesInput } from '../domain/types.ts';
import { isWindowsJob, windowsFits } from '../domain/windows-jobs.ts';
import { freePriority, keptFor, priorityLaneNames } from './priority-lanes.ts';
import { gateKeeps } from './gate.ts';
import { memoryAdmits, memoryShort } from './memory-floor.ts';
import { signedOutFor } from './signed-out.ts';
import { addressHolds, credentialHolds, herdrHolds, notReady, offNetwork, workTreeHolds } from './machine-holds.ts';
import type { CapBand } from './usage.ts';
import {
  diskHolds, diskWord, drainedHolds, eligible, fitsLane, freeOf, homeless, leavingHolds, leftHolds, pinOf, problemHits, room, roomFor, templateHolds,
  unpinnedCap, type MachineState, type MachineStateWithCredentialHold,
} from './assign.ts';

const percent = (frac: number): string => `${Math.round(frac * 100)}%`;
const usageNote = (band: CapBand, usedFrac: number): string => (band === 'soft' ? ` (usage soft limit, used ${percent(usedFrac)})` : '');

/** The lane cap that binds on `s` for `job`: its executor's when that leaves less room than the machine's, else the machine's, with its real number and how many lanes it counts in use. */
function laneFull(s: MachineStateWithCredentialHold, job: Job, pl?: PriorityLanesInput): string {
  const ex = job.spec.executor;
  const e = s.executors.get(ex)!;
  const id = s.machine.id;
  if (e.band === 'hard') return `usage hard limit stops executor ${ex} on ${id} (used ${percent(e.usedFrac)})`;
  const kept = keptFor(s.slots, job, pl) > 0 ? freePriority(s.slots) : [];
  if (roomFor(s, ex) > 0 && kept.length > 0 && (pinOf(job) === id || s.unpinned < unpinnedCap(s))) {
    // Only priority lanes held for high-priority jobs still to be placed are free (issues #535, #788).
    return `machine ${id} holds ${priorityLaneNames(kept)} for high-priority jobs still to be placed, the other ${s.occupied + s.assigned} are in use`;
  }
  if (roomFor(s, ex) > 0) {
    // Only its reserved lanes are free (issue #372).
    return `machine ${id} keeps ${s.cap - unpinnedCap(s)} of its ${s.cap} lanes for jobs pinned to it, the other ${s.unpinned} are in use`;
  }
  const executorInUse = e.occupied.length + e.assigned;
  const executorBinds = e.cap - executorInUse < room(s) || (e.cap - executorInUse === room(s) && e.cap < s.cap);
  if (executorBinds) return `executor ${ex}'s lane cap on ${id} is ${e.cap}${usageNote(e.band, e.usedFrac)}, all ${executorInUse} in use`;
  return `machine ${id}'s lane cap is ${s.cap}${usageNote(s.band, s.usedFrac)}, all ${s.occupied + s.assigned} in use`;
}

/** Why machine `s` did not take `job`, after the machine's id. */
function causeOf(s: MachineStateWithCredentialHold, job: Job, pl: PriorityLanesInput | undefined, cost: ExpectedCost | undefined): string {
  const m = s.machine;
  if (!m.online) return 'is offline';
  if (!windowsFits(m, job)) return 'is not a Windows machine';
  if (leavingHolds(m, job)) return 'is leaving';
  if (drainedHolds(m, job)) return `is drained since ${m.drained!.at}`;
  if (leftHolds(m, job)) return 'is the lost machine the job moved off';
  if (homeless(m)) return 'has not answered a probe: its home is not known';
  if (diskHolds(m, job)) return `has ${diskWord(m)} disk (${freeOf(m)})`;
  if (workTreeHolds(m, job)) return `has no usable work tree: ${m.workTreeProblem}`;
  if (addressHolds(m, job)) return offNetwork(m);
  if (credentialHolds(m, job, s.credentialHeld)) return notReady(m);
  if (herdrHolds(m, job)) return `has no working herdr: ${m.herdrProblem}`;
  if (templateHolds(m, job)) return `waits: ${m.template!.waiting}`;
  const out = signedOutFor(m.id, job, s.signedOut);
  if (out) return `has ${out.service} signed out`;
  const problem = job.pendingAnswer === undefined ? s.problems?.find((b) => problemHits(b, m.id, job)) : undefined;
  if (problem) return `has an open problem: ${problem.title}`;
  const gated = gateKeeps(m.id, job, s.gate);
  if (gated) return `is gated: ${gated}`;
  if (!fitsLane(s, job, pl)) return `is full: ${laneFull(s, job, pl)}`;
  if (!memoryAdmits(s.memory, cost)) return `is short of memory: ${memoryShort(s.memory!, cost)}`;
  return 'was not picked';
}

/**
 * Every machine that runs the job's executor but those `named`, with why it was left out (issue #2499), said after a
 * reason that names only those. None for a job pinned to a machine: it goes there or nowhere.
 */
export function leftOut(job: Job, states: readonly MachineStateWithCredentialHold[], named: readonly string[], pl?: PriorityLanesInput, cost?: ExpectedCost): string {
  if (pinOf(job) !== undefined) return '';
  const each = states.filter((s) => s.machine.executors.includes(job.spec.executor) && !named.includes(s.machine.id))
    .map((s) => `${s.machine.id} ${causeOf(s, job, pl, cost)}`);
  return each.length ? `; left out: ${each.join('; ')}` : '';
}

/** Why a job no machine has a lane for waits (issue #381): the lane cap that binds on the machine with the most of them, then the machines left out. */
export function waitReason(job: Job, states: MachineStateWithCredentialHold[], pl?: PriorityLanesInput, cost?: ExpectedCost): string {
  const ex = job.spec.executor;
  const able = states.filter((m) => eligible(m, job));
  if (able.length === 0 && isWindowsJob(job)) return windowsWait(job, states);
  const s = able.reduce((a, b) => (b.executors.get(ex)!.cap > a.executors.get(ex)!.cap ? b : a));
  return `waiting for a lane: ${laneFull(s, job, pl)}${leftOut(job, states, [s.machine.id], pl, cost)}`;
}

/**
 * Why a Windows job no Windows machine can take waits (issue #1350): none runs its executor, none of those is online, or
 * none of those takes it now (pinned elsewhere, or held there). It waits queued; it never goes to another machine.
 */
function windowsWait(job: Job, states: MachineState[]): string {
  const ex = job.spec.executor;
  const runs = states.map((s) => s.machine).filter((m: MachineSnapshot) => m.windows === true && m.executors.includes(ex));
  if (runs.length === 0) return `waiting for a Windows lane: no Windows machine runs executor ${ex}`;
  const online = runs.filter((m) => m.online);
  if (online.length === 0) return `waiting for a Windows lane: no Windows machine that runs executor ${ex} is online (${runs.map((m) => `${m.id} offline`).join(', ')})`;
  const pin = pinOf(job);
  if (pin !== undefined && !online.some((m) => m.id === pin)) return `waiting for a Windows lane: it is pinned to ${pin}, which is not an online Windows machine`;
  return `waiting for a Windows lane: no Windows machine that runs executor ${ex} takes a new job now (${online.map((m) => m.id).join(', ')})`;
}
