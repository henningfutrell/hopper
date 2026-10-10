// Lane tuning (issue #688, design.md "Lane tuning"): from a machine's resource history and the usage it burns, the
// number of lanes it can run — its lane recommendation —, next to the lanes it is configured with. Shadow only: the
// recommendation is shown and recorded, and the configured lanes stay what the decider uses. Re-exported by types.ts.

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
  /** The lanes the machine is configured with: what the decider uses. */
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
}

/** `GET /api/lanes/plan`: every machine's lane recommendation. */
export interface LaneTuningPlan {
  at: string;
  /** Only `shadow`: a recommendation is shown and recorded, never applied. */
  mode: 'shadow';
  windowDays: number;
  machines: LaneRecommendation[];
}
