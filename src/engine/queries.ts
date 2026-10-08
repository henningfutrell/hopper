// Read models for the HTTP edge.
import { isLocked } from '../domain/locked.ts';
import { effectivePriority, order } from '../decider/assign.ts';
import { laneEffect, readingsOf } from '../decider/usage.ts';
import { TERMINAL_STATUSES, type Job, type Lane, type PreSort, type QueueGate, type MachineSnapshot, type UsageReading, type UsageReport, type UsageSourceReport } from '../domain/types.ts';
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
  /** The locked entries (issue #355): failed jobs that stay in the queue until run again or dismissed, highest priority first, then oldest. */
  locked: Job[];
  /** Jobs that ended (finished, failed, cancelled, rejected) in the last `ENDED_WINDOW_MS`, newest end first. */
  ended: Job[];
  /** The user's queue gate (issue #159). */
  gate: QueueGate;
  /** The pre-sort of the waiting jobs not yet accepted. */
  presort: PreSort;
}

/** How far back `ended` reaches: the UI's cards count ended jobs over this window, and list the same jobs. */
export const ENDED_WINDOW_MS = 24 * 3_600_000;

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Queries {
  getQueue(): QueueView;
  getMachines(): Promise<MachineView[]>;
  getUsage(): Promise<UsageReading[]>;
  /** Every reading, every usage source's state, the limits, and the lane effect per machine (the decider's steps 1-2). */
  getUsageReport(): Promise<UsageReport>;
  /** Each usage source's name and state (when it last read, why it has no readings, its account). */
  getUsageSources(): UsageSourceReport[];
  /** Jobs that need a machine: on a busy or draining lane there, or waiting for an answer in a pane there (`resumeOn`). */
  jobsOnMachine(machineId: string): string[];
}

/** The locked entries among `all` (newest first, as the store lists them): highest priority first, then oldest. */
function lockedOf(all: Job[]): Job[] {
  const newest = new Map<string, Job>();
  for (const j of all) if (j.source && !newest.has(j.source.key)) newest.set(j.source.key, j);
  return all.filter((j) => isLocked(j, j.source && newest.get(j.source.key)))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export function createQueries(c: EngineContext): Queries {
  const getUsage = async (): Promise<UsageReading[]> => (await Promise.all(c.usage().map((u) => u.poll()))).flat();
  const getUsageSources = (): UsageSourceReport[] => c.usage().map((u) => ({ name: u.name, ...u.state?.() }));
  return {
    getQueue() {
      const all = c.store.jobs.list();
      // The decider's own order: the queue sorter's, then effective priority, then age.
      const queued = all.filter((j) => j.status === 'queued' || j.status === 'held');
      const ids = queueOrder(c, queued).jobIds;
      const waiting = order(queued.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) })), ids).map((x) => x.job);
      const running = all.filter((j) => j.status === 'claimed' || j.status === 'running').reverse();
      const waitingAnswer = all.filter((j) => j.status === 'waiting_answer').reverse();
      const operatorLed = all.filter((j) => j.status === 'operator_led').reverse();
      const parked = all.filter((j) => j.status === 'parked').reverse();
      const end = (j: Job) => j.finishedAt ?? j.updatedAt;
      const since = new Date(c.clock.now().getTime() - ENDED_WINDOW_MS).toISOString();
      const ended = all.filter((j) => TERMINAL_STATUSES.includes(j.status) && end(j) >= since)
        .sort((a, b) => end(b).localeCompare(end(a)));
      const presort = preSort(c, [...queued].reverse().filter(isUnaccepted));
      return { waiting, running, waitingAnswer, operatorLed, parked, locked: lockedOf(all), ended, gate: gateOf(c), presort };
    },
    async getMachines() {
      const [machines, usage] = await Promise.all([c.machines.list(), getUsage()]);
      const lanes = c.store.lanes.list();
      return machines.map((m) => ({
        ...m,
        lanes: lanes.filter((l) => l.machineId === m.id),
        usage: readingsOf(m.id, usage),
      }));
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
          // At the clock, as the decider reads it: a week window in its burn window shows as not throttling (issue #373).
          const { usedFrac, cap, band, executors } = laneEffect(m, readings, policy, c.clock.now().toISOString());
          return { machineId: m.id, label: m.label, online: m.online, maxLanes: m.maxLanes, usedFrac, cap, band, executors };
        }),
      };
    },
    jobsOnMachine(machineId) {
      const onLanes = c.store.lanes.list(machineId).flatMap((l) => (l.state !== 'idle' && l.jobId ? [l.jobId] : []));
      const waitingPanes = c.store.jobs.list({ status: ['waiting_answer'] }).filter((j) => j.resumeOn === machineId).map((j) => j.id);
      return [...new Set([...onLanes, ...waitingPanes])];
    },
  };
}
