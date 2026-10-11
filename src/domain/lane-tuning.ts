// Lane tuning (issue #688, design.md "Lane tuning"): from a machine's resource history and the usage it burns, the
// number of lanes it can run — its lane recommendation —, next to the lanes it is configured with. In shadow mode the
// recommendation is shown and recorded, and the configured lanes stay what the decider uses; in active mode it is
// applied within the bounds, each change with its reason, and an admin undoes it. Re-exported by types.ts.

export const LANE_TUNING_MODES = ['shadow', 'active'] as const;
/** `shadow`: recommend only. `active`: apply the recommendation within the bounds. */
export type LaneTuningMode = typeof LANE_TUNING_MODES[number];

/** A machine's lane tuning settings: whether it is tuned, the bounds a recommendation stays within, and the mode. */
export interface LaneTuning {
  autoTune: boolean;
  minLanes: number;
  maxLanes: number;
  mode: LaneTuningMode;
}

/** Each machine's lane tuning settings, by machine id; a machine absent has the defaults. */
export type LaneTuningSettings = Readonly<Record<string, LaneTuning>>;

/** A machine with no settings saved: tuned, from 1 to 8 lanes, in shadow. A saved setting without a mode is in shadow. */
export const DEFAULT_LANE_TUNING: LaneTuning = { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'shadow' };

/**
 * Applied lanes: in active mode, the lanes lane tuning set for a machine (`lanes`, from `from`), and why. `undone`: an
 * admin undid that change — `lanes` are the lanes before it, `from` the lanes undone, which are not applied again
 * until the recommendation moves.
 */
export interface AppliedLanes {
  lanes: number;
  from: number;
  at: string;
  reason: string;
  undone?: boolean;
}

/** Each machine's applied lanes, by machine id. */
export type AppliedLanesSettings = Readonly<Record<string, AppliedLanes>>;

/** The least confidence a recommendation is applied with: half an hour of samples. */
export const MIN_APPLY_CONFIDENCE = 0.5;

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

/** Where usage stands against the usage limits, for lane tuning: `near` is within NEAR_SOFT below the soft limit. */
export const LANE_USAGE_BANDS = ['free', 'near', 'soft', 'hard'] as const;
export type LaneUsageBand = typeof LANE_USAGE_BANDS[number];

/** A machine's lane recommendation: the lanes it can run now, the configured lanes, and why. */
export interface LaneRecommendation {
  machineId: string;
  label?: string;
  online: boolean;
  /** The lanes the machine is configured with. */
  configured: number;
  /** The lanes the decider uses: the applied lanes, within the bounds, in active mode; else the configured lanes. */
  inUse: number;
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
  /** In active mode, the last change can be undone: back `to` these lanes. */
  undo?: { to: number };
}

/** A change to a machine's lanes in active mode: lane tuning applied a recommendation, or an admin undid one. */
export type LaneChange = { at: string; machineId: string; from: number; to: number } & (
  { kind: 'applied'; reason: string } | { kind: 'undone'; by: string }
);

/** `GET /api/lanes/plan`: every machine's lane recommendation, and the latest changes, newest first. */
export interface LaneTuningPlan {
  at: string;
  windowDays: number;
  machines: LaneRecommendation[];
  changes: LaneChange[];
}
