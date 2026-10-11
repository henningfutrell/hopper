// Job cost profiles (issue #688, design.md "Job cost profiles"): per finished job, what its runs cost on their machine —
// one lane's share of CPU, memory and disk net of the machine's baseline, peaks and averages —, its duration and the
// plan usage it burned, grouped by repository, job cost kind and template. Read from the job's events and the machine
// and usage samples; nothing new is kept. Re-exported by lane-tuning.ts, so by types.ts.

/** How far back the job cost profiles read the runs. */
export const JOB_COST_WINDOW_DAYS = 30;

/** At most this many job cost profiles are listed, newest first; the groups count every one. */
export const JOB_COSTS_LISTED = 100;

/** What a job was asked to do, for its cost: research, a proposal, else the work itself (code). */
export const JOB_COST_KINDS = ['code', 'research', 'proposal'] as const;
export type JobCostKind = typeof JOB_COST_KINDS[number];

/** How the job cost profiles are grouped. */
export const JOB_COST_GROUPINGS = ['repo', 'kind', 'template'] as const;
export type JobCostGrouping = typeof JOB_COST_GROUPINGS[number];

/** One resource's share for one lane, net of the machine's baseline: the average and the peak over the samples. */
export interface ResourceCost {
  avg: number;
  peak: number;
}

/** The event that ends a job run. */
export const JOB_RUN_ENDS = ['finished', 'failed', 'cancelled', 'requeued', 'parked'] as const;
export type JobRunEnd = typeof JOB_RUN_ENDS[number];

/**
 * A job run: from the job's claim on a machine to the event that ended it, with what the machine's samples in that time
 * show. Each resource is one lane's share — the sample's use less the machine's baseline, divided by its lanes in use —,
 * absent when no sample read it. CPU busy as a share of the machine; memory and disk in bytes. `usage`: per usage window,
 * the share of its limit the machine's usage samples rose by in that time (a reset in it reads as no rise), the whole
 * machine's, not yet divided by its lanes.
 */
export interface JobRun {
  jobId: string;
  machineId: string;
  startedAt: string;
  endedAt: string;
  end: JobRunEnd;
  samples: number;
  /** The average lanes in use over the samples; absent: none. */
  lanesBusyAvg?: number;
  cpu?: ResourceCost;
  memoryBytes?: ResourceCost;
  diskBytes?: ResourceCost;
  usage: Record<string, number>;
}

/**
 * A job cost profile: what a finished job cost, over all its runs. Durations add up, averages are weighted by samples,
 * the peak is the highest; `usage` is per usage window the share of its limit each run burned for its lane (the rise
 * divided by the lanes in use). `machineId`: its last run's; `template`: that machine's, when it is a sandbox box.
 */
export interface JobCostProfile {
  jobId: string;
  repo?: string;
  kind: JobCostKind;
  template?: string;
  machineId: string;
  outcome: 'finished' | 'failed';
  finishedAt: string;
  durationMs: number;
  runs: number;
  samples: number;
  cpu?: ResourceCost;
  memoryBytes?: ResourceCost;
  diskBytes?: ResourceCost;
  usage: Record<string, number>;
}

/**
 * The job cost profiles of one repository, job cost kind or template: how many, how many failed, and the mean of each
 * figure over the profiles that have it. What a job of the group is expected to cost.
 */
export interface JobCostGroup {
  key: string;
  jobs: number;
  failed: number;
  durationMs: number;
  samples: number;
  cpu?: ResourceCost;
  memoryBytes?: ResourceCost;
  diskBytes?: ResourceCost;
  usage: Record<string, number>;
}

/** `GET /api/lanes/costs`: the latest job cost profiles, newest first, and every one grouped. */
export interface JobCosts {
  at: string;
  windowDays: number;
  jobs: JobCostProfile[];
  groups: Record<JobCostGrouping, JobCostGroup[]>;
}

/** A job cost group gives a waiting job its expected cost only with at least this many jobs. */
export const MIN_EXPECTED_COST_JOBS = 3;

/**
 * A waiting job's expected cost (placement by expected cost): the job cost group it falls in — its repository's, else
 * its job cost kind's — with at least `MIN_EXPECTED_COST_JOBS` jobs. One lane's share of CPU and memory, as the group's.
 */
export interface ExpectedCost {
  group: 'repo' | 'kind';
  key: string;
  jobs: number;
  cpu?: ResourceCost;
  memoryBytes?: ResourceCost;
}
