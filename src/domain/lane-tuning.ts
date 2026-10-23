// Lane tuning (issue #688, design.md "Lane tuning"): from a machine's resource history and the usage it burns, the
// number of lanes it can run — its lane recommendation —, next to the lanes it is configured with. The hopper shows and
// records each recommendation and applies none by itself: an admin applies one — the machine's configured lanes, set as
// an edit of the machine sets them —, dismisses it until it moves, or undoes the last one applied. Re-exported by types.ts.

/** A machine's lane tuning settings: whether it is tuned, and the bounds a recommendation stays within. */
export interface LaneTuning {
  autoTune: boolean;
  minLanes: number;
  maxLanes: number;
}

/** Each machine's lane tuning settings, by machine id; a machine absent has the defaults. */
export type LaneTuningSettings = Readonly<Record<string, LaneTuning>>;

/** A machine with no settings saved: tuned, from 1 to 8 lanes. */
export const DEFAULT_LANE_TUNING: LaneTuning = { autoTune: true, minLanes: 1, maxLanes: 8 };

/** An admin dismissed a machine's recommendation of `lanes` while it was configured with `configured`: not offered again until one of them moves. */
export interface LaneDismissal {
  lanes: number;
  configured: number;
  at: string;
  by: string;
}

/** Each machine's dismissal, by machine id. */
export type LaneDismissals = Readonly<Record<string, LaneDismissal>>;

/** The most lanes a bound may name. */
export const MAX_TUNED_LANES = 64;

/** How far back the lane headroom reads the machine samples. */
export const LANE_TUNING_WINDOW_DAYS = 7;

/** The share of a resource at or above which a machine sample shows resource pressure. */
export interface ResourcePressure {
  cpu: number;
  memory: number;
  disk: number;
}

export const RESOURCE_PRESSURE: ResourcePressure = { cpu: 0.95, memory: 0.9, disk: 0.95 };

/**
 * Issue #2499: a machine whose CPU quota throttled it in this share of its CPU periods or more, since its read before, takes
 * no new job: its tasks already want more CPU than the quota gives, as a seat at its quota does while CPU busy reads lower.
 */
export const CPU_THROTTLE_FRAC = 0.5;

/**
 * Lane load: what a machine's samples with this many lanes in use show. The averages are over the samples that read
 * the resource; absent when none did.
 */
export interface LaneLoad {
  machineId: string;
  lanesBusy: number;
  samples: number;
  /** Samples at or above each resource pressure. */
  pressured: { cpu: number; memory: number; disk: number };
  cpuAvg?: number;
  memUsedAvgBytes?: number;
  memTotalBytes?: number;
}

/**
 * Lane progress: the job runs on a machine that ended `finished` or `failed` at this many lanes in use (a run's average
 * lanes in use, rounded, at least 1), and how many of them failed. Slow progress shows in the failures.
 */
export interface LaneProgress {
  machineId: string;
  lanesBusy: number;
  runs: number;
  failed: number;
}

/** Where usage stands against the usage limits, for lane tuning: `near` is within NEAR_SOFT below the soft limit. */
export const LANE_USAGE_BANDS = ['free', 'near', 'soft', 'hard'] as const;
export type LaneUsageBand = typeof LANE_USAGE_BANDS[number];

/** A machine's lane recommendation: the lanes it can run now, the configured lanes, and why. */
export interface LaneRecommendation {
  machineId: string;
  label?: string;
  online: boolean;
  /** The lanes the machine is configured with: the lanes the decider uses. */
  configured: number;
  /** The lanes recommended, within the bounds. The configured lanes when auto-tune is off or the history is too short. */
  lanes: number;
  /** Lane headroom: the most lanes the history shows the machine runs without resource pressure; absent: not known. */
  headroom?: number;
  /** One plain sentence. */
  reason: string;
  /** 0..1: how much history the recommendation stands on. 0: none. */
  confidence: number;
  usedFrac: number;
  usage: LaneUsageBand;
  tuning: LaneTuning;
  /** An admin can apply it: the configured lanes go `to` these. Absent: nothing to apply, or dismissed. */
  apply?: { to: number };
  /** An admin dismissed this recommendation. */
  dismissed?: { at: string; by: string };
  /** The last recommendation applied can be undone: back `to` these lanes. */
  undo?: { to: number };
  /**
   * `jev`: the lanes are Jev's pick at the `lane-count` decision point (issue #550), applied as the point is active and
   * Jev was sure; `rules` holds the rules' own recommendation. Absent: the rules decided.
   */
  decidedBy?: 'jev';
  rules?: { lanes: number; reason: string; confidence: number };
}

/** Jev's applied pick of a machine's lanes, and the rules' recommendation and configured lanes it was picked at. */
export interface JevLanes {
  lanes: number;
  confidence: number;
  rulesLanes: number;
  configured: number;
}

/** Jev's applied pick of a waiting job's machine (`job-machine`, issue #550): placement takes it first when a lane is free there. */
export interface PlacementPick {
  machineId: string;
  confidence: number;
}

/**
 * A change to a machine's configured lanes by lane tuning: an admin applied a recommendation, or undid one. `by` absent
 * on an applied change: the hopper applied it itself, before each one was an admin's (tenant migration 38).
 */
export type LaneChange = { at: string; machineId: string; from: number; to: number } & (
  { kind: 'applied'; reason: string; by?: string } | { kind: 'undone'; by: string }
);

/** The event types a lane change is recorded as. */
export const LANE_CHANGE_EVENTS = ['lanes.applied', 'lanes.undone'] as const;

/** A `lanes.applied` or `lanes.undone` event as the lane change it records. */
export function laneChangeOf(e: { at: string; type: string; data: unknown }): LaneChange {
  const d = e.data as { machineId: string; from: number; to: number; reason?: string; by?: string };
  const base = { at: e.at, machineId: d.machineId, from: d.from, to: d.to };
  return e.type === 'lanes.applied'
    ? { ...base, kind: 'applied', reason: d.reason ?? '', ...(d.by === undefined ? {} : { by: d.by }) }
    : { ...base, kind: 'undone', by: d.by ?? '' };
}

/** `GET /api/lanes/plan`: every machine's lane recommendation, and the latest changes, newest first. */
export interface LaneTuningPlan {
  at: string;
  windowDays: number;
  machines: LaneRecommendation[];
  changes: LaneChange[];
}

export * from './job-costs.ts';
