// Read models for the HTTP edge.
import { credentialHeld } from '../domain/machine-credentials.ts';
import { cleanupLeftoversOf, machineLeftoversOf, type MachineCleanupLeftovers } from '../domain/resource-ledger.ts';
import { liveUseOf, type LiveUse } from '../domain/job-resources.ts';
import { isLocked } from '../domain/locked.ts';
import type { InFlight, WorkItemLedger, WorkItemState } from '../domain/work-items.ts';
import { effectivePriority, order } from '../decider/assign.ts';
import { laneEffect, readingsOf } from '../decider/usage.ts';
import { TERMINAL_STATUSES, highFirst, withPhase, isHighPriority, prioritySettingsOf, type Job, type Lane, type PreSort, type QueueGate, type MachineSnapshot, type HopperDisk, type MachineLeftovers, type SweepSettings, type UsageReading, type UsageReport, type UsageSourceReport } from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { usageLimitsOf } from './usage-limits.ts';
import { gateOf, isUnaccepted, preSort } from './queue-gate.ts';
import { queueOrder } from './queue-order.ts';

export interface QueueView {
  waiting: Job[];
  running: Job[];
  /** Jobs paused on a question, oldest first. They hold no lane. */
  waitingAnswer: Job[];
  /** Jobs claimed as operator-led (issue #318), oldest first: worked by hand, on no lane. */
  operatorLed: Job[];
  /** Parked jobs (issue #501), oldest first: on no lane, no pane, no agent, until re-queued. */
  parked: Job[];
  /** Jobs on their own wait (issue #483), the longest waiting first. */
  waitingOn: Job[];
  /** The locked entries (issue #355): failed jobs that stay in the queue until run again or dismissed, highest priority first, then oldest. */
  locked: Job[];
  /** How many work items are in each state (issue #1067): the work-item ledger's counts, the ones every view shows. */
  items: Record<WorkItemState, number>;
  /** How many work items are in flight, and in each part (issues #1113, #1164): the ledger's, by `inFlightOf`. The header's badge and the dashboard's card. */
  inFlight: InFlight;
  /** Jobs that ended (finished, failed, cancelled, rejected) in the last `ENDED_WINDOW_MS`, newest end first. */
  ended: Job[];
  /** The user's queue gate (issue #159). */
  gate: QueueGate;
  /** The pre-sort of the waiting jobs not yet accepted. */
  presort: PreSort;
  /** The high-priority threshold (issue #535): a job at or above it is high priority, tagged and listed first. */
  highPriority: number;
  /**
   * The critical priority (issues #373, #2203, `HOPPER_CRITICAL_PRIORITY`): a job at or above it is a critical job — it may
   * take a lane over the cap, and the critical job tracker shows it on every page. 0: off.
   */
  criticalPriority: number;
  /** Each waiting job's effective priority (issue #1776), the one the queue order uses: its priority with any boost. */
  effectivePriority: Record<string, number>;
}

/** How far back `ended` reaches: the UI's cards count ended jobs over this window, and list the same jobs. */
export const ENDED_WINDOW_MS = 24 * 3_600_000;

/**
 * `hopperDisk`: the hopper's own disk use there, as the sweep last measured it (issue #1120); absent, never measured.
 * `leftovers`: the leftovers there the sweep does not judge, for a person to keep or remove (issue #1116); absent, none listed.
 * `cleanupLeftovers`: the cleanup leftovers there (issue #2504 part 3), counted, with the bytes the disk measure says they hold (part 10); absent, none.
 */
export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[]; hopperDisk?: HopperDisk; leftovers?: MachineLeftovers; cleanupLeftovers?: MachineCleanupLeftovers };

export interface Queries {
  getQueue(): QueueView;
  getMachines(): Promise<MachineView[]>;
  /** What a job's scope uses now (issue #2498), on each machine whose last reading has it. */
  getLiveUse(jobId: string): Promise<LiveUse[]>;
  getUsage(): Promise<UsageReading[]>;
  /** Every reading, every usage source's state, the limits, and the lane effect per machine (the decider's steps 1-2). */
  getUsageReport(): Promise<UsageReport>;
  /** Each usage source's name and state (when it last read, why it has no readings, its account). */
  getUsageSources(): UsageSourceReport[];
  /** Jobs that need a machine: on a busy or draining lane there, or waiting for an answer in a pane there (`resumeOn`). */
  jobsOnMachine(machineId: string): string[];
}

/** The locked entries among `all`, by the work-item ledger's `ledger`: highest priority first, then oldest. */
function lockedOf(all: Job[], ledger: Pick<WorkItemLedger, 'get'>): Job[] {
  return all.filter((j) => j.status === 'failed' && isLocked(j, j.source && ledger.get(j.source.key)))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export function createQueries(c: EngineContext, diskOf: (machineId: string, sweep?: SweepSettings) => HopperDisk | undefined = () => undefined, leftoversOf: (machineId: string) => MachineLeftovers | undefined = () => undefined): Queries {
  const getUsage = async (): Promise<UsageReading[]> => (await Promise.all(c.usage().map((u) => u.poll()))).flat();
  const getUsageSources = (): UsageSourceReport[] => c.usage().map((u) => ({ name: u.name, ...u.state?.() }));
  return {
    getQueue() {
      // Each with its phase named (issue #548): the views show it.
      const all = c.store.jobs.list().map(withPhase);
      // The decider's own order: the queue sorter's, then effective priority, then age.
      const queued = all.filter((j) => j.status === 'queued' || j.status === 'held');
      const ids = queueOrder(c, queued).jobIds;
      const candidates = queued.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) }));
      const waiting = order(candidates, ids).map((x) => x.job);
      // High-priority jobs first in every list (issue #535), each list's own order within.
      const { highPriority } = prioritySettingsOf(c.store.settings.getPriorityLanes());
      const first = (jobs: Job[]): Job[] => highFirst(jobs, (j) => isHighPriority(j.priority, highPriority));
      const running = first(all.filter((j) => j.status === 'claimed' || j.status === 'running').reverse());
      const waitingAnswer = first(all.filter((j) => j.status === 'waiting_answer').reverse());
      const operatorLed = first(all.filter((j) => j.status === 'operator_led').reverse());
      const parked = first(all.filter((j) => j.status === 'parked').reverse());
      // On their own wait (issue #483): the longest waiting first, after high-priority ones.
      const waitingOn = first(all.filter((j) => j.status === 'waiting_on').reverse());
      const end = (j: Job) => j.finishedAt ?? j.updatedAt;
      const since = new Date(c.clock.now().getTime() - ENDED_WINDOW_MS).toISOString();
      const ended = all.filter((j) => TERMINAL_STATUSES.includes(j.status) && end(j) >= since)
        .sort((a, b) => end(b).localeCompare(end(a)));
      const presort = preSort(c, [...queued].reverse().filter(isUnaccepted));
      return { waiting, running, waitingAnswer, operatorLed, parked, waitingOn, locked: lockedOf(all, c.store.workItems), items: c.store.workItems.counts(), inFlight: c.store.workItems.inFlight(), ended, gate: gateOf(c), presort, highPriority, criticalPriority: c.policy.pacing?.criticalPriority ?? 0, effectivePriority: Object.fromEntries(candidates.map((x) => [x.job.id, x.effectivePriority])) };
    },
    async getMachines() {
      const [machines, usage] = await Promise.all([c.machines.list(), getUsage()]);
      const lanes = c.store.lanes.list();
      const acceptanceMap = new Map(c.store.credentialAcceptances.list().map((a) => [a.machineKey, a]));
      const { strict } = c.store.credentialAcceptances.settings();
      const ended = cleanupLeftoversOf(c.store.resourceLedger.open(), (id) => c.store.jobs.get(id), c.clock.now().getTime());
      return machines.map((m) => {
        const hopperDisk = diskOf(m.id, m.sweep);
        const leftovers = leftoversOf(m.id), cleanupLeftovers = machineLeftoversOf(ended, m.id, hopperDisk?.jobs);
        const acceptance = acceptanceMap.get(m.id);
        // Issue #1467: the decider's own rule, so the card never says other than what it does.
        const held = credentialHeld(m.infraCredentials, acceptance, strict);
        return { ...m, lanes: lanes.filter((l) => l.machineId === m.id), usage: readingsOf(m.id, usage), ...(hopperDisk ? { hopperDisk } : {}), ...(leftovers ? { leftovers } : {}), ...(cleanupLeftovers ? { cleanupLeftovers } : {}), ...(acceptance ? { credentialAcceptance: acceptance } : {}), ...(held ? { credentialHeld: true } : {}) };
      });
    },
    async getLiveUse(jobId) {
      return liveUseOf(await c.machines.list(), jobId);
    },
    getUsage,
    getUsageSources,
    async getUsageReport() {
      const [machines, readings] = await Promise.all([c.machines.list(), getUsage()]);
      const policy = policyOf(c);
      return {
        readings,
        sources: getUsageSources(),
        limits: usageLimitsOf(c),
        machines: machines.map((m) => {
          // At the clock, as the decider reads it: a week window in its burn window throttles up to 100% (issues #373, #2169).
          const { usedFrac, cap, band, throttle, executors } = laneEffect(m, readings, policy, c.clock.now().toISOString());
          return { machineId: m.id, label: m.label, online: m.online, maxLanes: m.maxLanes, usedFrac, cap, band, ...(throttle ? { throttle } : {}), executors, ...(m.usageLimits ? { usageLimits: { ...m.usageLimits } } : {}) };
        }),
      };
    },
    jobsOnMachine(machineId) {
      const onLanes = c.store.lanes.list(machineId).flatMap((l) => (l.state !== 'idle' && l.jobId ? [l.jobId] : []));
      const waitingPanes = c.store.jobs.list({ status: ['waiting_answer', 'waiting_on'] }).filter((j) => j.resumeOn === machineId).map((j) => j.id);
      return [...new Set([...onLanes, ...waitingPanes])];
    },
  };
}
