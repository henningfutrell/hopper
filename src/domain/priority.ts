// High priority and priority lanes (issue #535, design.md "High priority everywhere"): a job at or above the
// high-priority threshold is tagged and listed first wherever jobs are listed or wait, and the most reliable lanes
// are kept for it. Re-exported by types.ts.
import type { Job, JobId, LaneId, MachineId, Question } from './types.ts';
import type { QuestionFork, QuestionShifts } from './phase.ts';

/** What a priority lane does while no high-priority job waits: stays free for one, or takes a default job (never a low one). */
export const PRIORITY_LANE_IDLE = ['keep-free', 'share'] as const;
export type PriorityLaneIdle = typeof PRIORITY_LANE_IDLE[number];

/**
 * The user's priority lane settings, kept in the database and read at each Decision. `highPriority`: the
 * threshold — a job whose priority is at or above it is high priority. `count`: how many priority lanes.
 * `windowDays`, `minRuns`: the history lane reliability is measured over, and the runs a lane needs in it to be
 * ranked. `manual`: the lanes an admin chose; absent, the most reliable lanes are chosen.
 */
export interface PriorityLaneSettings {
  highPriority: number;
  count: number;
  whenIdle: PriorityLaneIdle;
  windowDays: number;
  minRuns: number;
  manual?: LaneId[];
}

/** `hopper:high` gives 75: it is high priority by default. */
export const DEFAULT_PRIORITY_LANE_SETTINGS: PriorityLaneSettings = { highPriority: 75, count: 1, whenIdle: 'keep-free', windowDays: 14, minRuns: 5 };

/** The bounds the settings are checked against. */
export const PRIORITY_LANE_BOUNDS = { highPriority: { min: 1, max: 100 }, count: { min: 0, max: 32 }, windowDays: { min: 1, max: 90 }, minRuns: { min: 1, max: 1000 } } as const;

/** Below the default priority (50): a low job never takes a priority lane. */
export const LOW_PRIORITY_BELOW = 50;

/** Whether a priority is high priority: at or above the threshold. */
export const isHighPriority = (priority: number, threshold: number): boolean => priority >= threshold;

/** A job's live priority as a question, login, failure or hand-off carries it on a route and in an event. */
export interface PriorityTag { priority: number; high: boolean }

/**
 * A question as the routes answer it: with its job's live priority (issue #535), the phase shifts it offers now (issue
 * #548), and the forks made from it (issue #570).
 */
export type QuestionView = Question & PriorityTag & { shifts?: QuestionShifts; forks?: QuestionFork[] };

/** The tag of a job's priority; undefined for no job. */
export const priorityTag = (priority: number | undefined, threshold: number): PriorityTag | undefined =>
  (priority === undefined ? undefined : { priority, high: isHighPriority(priority, threshold) });

/** The settings in force: the user's saved ones, else the defaults. */
export const prioritySettingsOf = (saved: PriorityLaneSettings | undefined): PriorityLaneSettings => saved ?? DEFAULT_PRIORITY_LANE_SETTINGS;

/** The tag of the job `jobId` names, by its live priority; undefined when there is no such job. */
export function jobPriorityTag(jobs: { get(id: JobId): Job | undefined }, saved: PriorityLaneSettings | undefined, jobId: JobId | undefined): PriorityTag | undefined {
  const job = jobId === undefined ? undefined : jobs.get(jobId);
  return priorityTag(job?.priority, prioritySettingsOf(saved).highPriority);
}

/** High-priority items first, then as they were: a stable sort, so each list keeps its own order within. */
export function highFirst<T>(items: readonly T[], high: (item: T) => boolean): T[] {
  return items.map((item, i) => ({ item, i, h: high(item) })).sort((a, b) => Number(b.h) - Number(a.h) || a.i - b.i).map((x) => x.item);
}

/** What the decider reads of the priority lanes (`DecisionInputs.priorityLanes`): the lanes, best first, and how they act. */
export interface PriorityLanesInput {
  lanes: LaneId[];
  highPriority: number;
  whenIdle: PriorityLaneIdle;
}

/** One lane's history over the window: the facts its reliability is measured from. */
export interface LaneReliability {
  laneId: LaneId;
  machineId: MachineId;
  /** Runs that ended on it: finished, failed, or paused on a question. Cancelled runs are not counted. */
  runs: number;
  finished: number;
  failed: number;
  /** Failures that were not the job's fault: the machine offline or not dialled in, a start or a dialog it could not get past, a pane lost. */
  laneFaults: number;
  /** Lane faults in the last day. */
  recentFaults: number;
  /** Finished of the runs that finished or failed, 0..1; absent with neither. */
  successRate?: number;
  /** The median time from claim to start, ms; absent when none started. */
  medianStartMs?: number;
  /** Runs without a lane fault, newer runs weighing more: what lanes are ranked by. 0..1. */
  score: number;
  lastRunAt?: string;
}

/** A lane as the priority lanes view shows it: its history, its rank and why it is or is not a priority lane. */
export interface PriorityLaneView extends LaneReliability {
  /** 1 = the most reliable; absent: not ranked (too few runs, or the machine offline). */
  rank?: number;
  priority: boolean;
  reason: string;
}

/** `GET /api/priority-lanes`: the settings and their defaults, the priority lanes now, and every lane measured. */
export interface PriorityLanesView {
  settings: PriorityLaneSettings;
  defaults: PriorityLaneSettings;
  /** The priority lanes now, best first. */
  chosen: LaneId[];
  /** How they were chosen: by reliability, by an admin, or none yet (no lane has enough history). */
  by: 'reliability' | 'manual' | 'none';
  lanes: PriorityLaneView[];
  /** When the lanes were last measured. */
  measuredAt: string;
  /** How much more reliable (score, 0..1) a lane must be to take a priority lane's place: no flapping. */
  switchMargin: number;
}
