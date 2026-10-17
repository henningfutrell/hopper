// Preemption (issue #1525, design.md "Preemption"): a job of strictly higher priority that waits for a lane, with every
// lane it may use busy, takes the lane of a running job of lower priority. That job is parked on the Park button's path —
// its work tree, agent session and checkpoint kept — and queued again at once, at its own priority, ahead of the other
// jobs of that priority; its claim resumes its agent session. A job that has run less than the minimum run time is never
// preempted, so no job is preempted again and again. The admin's setting turns it off. Pure.
import type { JobId, LaneId, MachineId } from './types.ts';

export interface PreemptionSettings {
  /** Whether a higher-priority job may take a running job's lane. */
  enabled: boolean;
  /** Minutes a job runs, from its start or resume, before it may be preempted. */
  minRunMinutes: number;
}

export const DEFAULT_PREEMPTION: PreemptionSettings = { enabled: true, minRunMinutes: 10 };

/** The longest minimum run time a person may set: a day, in minutes. */
export const MAX_PREEMPTION_MIN_RUN_MINUTES = 24 * 60;

/** What the decider reads when preemption is on (absent: off). */
export interface PreemptionInput {
  /** The minimum run time, in milliseconds. */
  minRunMs: number;
  /** The executors that can park a job: only their jobs are preempted. */
  parkingExecutors: string[];
}

/** A running job the decider parks so that a waiting job of higher priority takes its lane. */
export interface PreemptPlan {
  /** The job preempted. */
  jobId: JobId;
  laneId: LaneId;
  machineId: MachineId;
  /** The waiting job that takes its lane. */
  by: JobId;
  /** The live priorities of both. */
  priority: number;
  byPriority: number;
  reason: string;
}

/**
 * Set on a job when it is preempted (issue #1525): which job took its lane, both priorities, where. Set on the running
 * job when the Decision names it, kept while it is parked and queued again, cleared when it runs again.
 */
export interface JobPreempted {
  at: string;
  by: JobId;
  byPriority: number;
  priority: number;
  machineId: MachineId;
}

/** A preemption whose park has not gone through after this long is void: the decider may preempt again. */
export const PREEMPT_IN_FLIGHT_MS = 2 * 60_000;

/** What the Jobs view and the events say about a preempted job. */
export const preemptedWhy = (p: Pick<JobPreempted, 'by' | 'byPriority' | 'priority'>): string =>
  `Preempted: job ${p.by} (priority ${p.byPriority}) took its lane; it had priority ${p.priority}. It resumes from where it stopped when a lane is free.`;

/** The decider's input for the user's settings: undefined when preemption is off. */
export const preemptionInput = (s: PreemptionSettings, parkingExecutors: readonly string[]): PreemptionInput | undefined =>
  s.enabled ? { minRunMs: s.minRunMinutes * 60_000, parkingExecutors: [...parkingExecutors] } : undefined;
