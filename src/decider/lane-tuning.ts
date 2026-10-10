// Lane tuning (issue #688, design.md "Lane tuning"): the deterministic rules. Lane headroom from a machine's lane
// load — the most lanes in use its history shows without resource pressure, plus what each lane's measured cost leaves
// room for —, and the lane recommendation: the headroom below the soft limit, never more than the configured lanes
// near it or past it, within the machine's bounds. Pure, like the rest of the decider.
import {
  LANE_TUNING_WINDOW_DAYS, type LaneLoad, type LaneRecommendation, type LaneTuning, type LaneUsageBand,
} from '../domain/types.ts';

/** A lane count counts once the machine ran it this many samples (minutes). */
export const MIN_LANE_SAMPLES = 10;
/** A lane count shows resource pressure when more than this share of its samples do. */
export const PRESSURE_SHARE = 0.05;
/** Usage within this much below the soft limit is near it. */
export const NEAR_SOFT = 0.1;
/** At most this many lanes past the most the history shows. */
export const MAX_LANE_STEP = 2;
/** What the lanes past the most seen may fill, at a lane's measured cost. */
export const LANE_TARGET = { cpu: 0.9, memory: 0.85 } as const;
/** A recommendation that stands on this many samples (an hour) has confidence 1. */
export const FULL_CONFIDENCE_SAMPLES = 60;

export interface LaneHeadroom {
  /** The most lanes the machine runs without resource pressure. */
  lanes: number;
  /** The samples of the lane count it stands on. */
  samples: number;
  why: string;
}

const lanesText = (n: number): string => `${n} lane${n === 1 ? '' : 's'}`;
const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** The resource with the most samples at or above its pressure. */
function pressureOf(l: LaneLoad): string {
  const p = l.pressured;
  return p.memory > p.cpu && p.memory >= p.disk ? 'memory' : p.disk > p.cpu ? 'disk' : 'CPU';
}

const pressured = (l: LaneLoad): boolean => Math.max(l.pressured.cpu, l.pressured.memory, l.pressured.disk) > PRESSURE_SHARE * l.samples;

/** How many lanes of `perLane` fit between `used` and `target` (a lane that costs nothing measured: no limit). */
function room(used: number | undefined, base: number | undefined, span: number, target: number | undefined): number {
  if (used === undefined || base === undefined || target === undefined) return MAX_LANE_STEP;
  const perLane = (used - base) / span;
  return perLane <= 0 ? MAX_LANE_STEP : Math.floor((target - used) / perLane + 1e-9);
}

/** Lane headroom from a machine's lane load; undefined when no lane count of 1 or more ran for MIN_LANE_SAMPLES. */
export function laneHeadroom(loads: readonly LaneLoad[]): LaneHeadroom | undefined {
  const counted = loads.filter((l) => l.samples >= MIN_LANE_SAMPLES).sort((a, b) => a.lanesBusy - b.lanesBusy);
  if (!counted.some((l) => l.lanesBusy >= 1)) return undefined;
  const first = counted.find((l) => l.lanesBusy >= 1 && pressured(l));
  if (first) {
    const below = counted.filter((l) => l.lanesBusy < first.lanesBusy).at(-1);
    const lanes = first.lanesBusy - 1;
    const p = first.pressured;
    const n = Math.max(p.cpu, p.memory, p.disk);
    return {
      lanes, samples: below?.samples ?? first.samples,
      why: `${pressureOf(first)} pressure at ${first.lanesBusy} lanes in use (${n} of ${first.samples} samples): ${lanes === 0 ? 'no lane runs' : `${lanesText(lanes)} run${lanes === 1 ? 's' : ''}`} without it`,
    };
  }
  const top = counted.at(-1)!;
  const base = counted[0]!;
  if (base.lanesBusy === top.lanesBusy) {
    return { lanes: top.lanesBusy, samples: top.samples, why: `no resource pressure at ${lanesText(top.lanesBusy)} in use, the most seen; no lower lane count to measure a lane's cost` };
  }
  const span = top.lanesBusy - base.lanesBusy;
  const memTarget = top.memTotalBytes === undefined ? undefined : LANE_TARGET.memory * top.memTotalBytes;
  const extra = Math.max(0, Math.min(MAX_LANE_STEP,
    room(top.memUsedAvgBytes, base.memUsedAvgBytes, span, memTarget),
    room(top.cpuAvg, base.cpuAvg, span, LANE_TARGET.cpu)));
  const costs = [
    ...(top.memUsedAvgBytes !== undefined && base.memUsedAvgBytes !== undefined ? [`${(Math.max(0, top.memUsedAvgBytes - base.memUsedAvgBytes) / span / 1024 ** 3).toFixed(1)} GiB of memory`] : []),
    ...(top.cpuAvg !== undefined && base.cpuAvg !== undefined ? [`${pct(Math.max(0, top.cpuAvg - base.cpuAvg) / span)} CPU`] : []),
  ];
  return {
    lanes: top.lanesBusy + extra, samples: top.samples,
    why: `no resource pressure up to ${lanesText(top.lanesBusy)} in use; `
      + `${costs.length ? `a lane uses about ${costs.join(' and ')}` : 'a lane\'s cost is not read'}: room for ${extra} more`,
  };
}

/** Where usage stands against the usage limits. */
export function laneUsageBand(usedFrac: number, soft: number, hard: number): LaneUsageBand {
  return usedFrac >= hard ? 'hard' : usedFrac >= soft ? 'soft' : usedFrac >= soft - NEAR_SOFT ? 'near' : 'free';
}

const USAGE_TEXT: Readonly<Record<Exclude<LaneUsageBand, 'free'>, string>> = { near: 'is near', soft: 'is past', hard: 'is at or past' };

export interface LaneTuningInput {
  machine: { id: string; label?: string; online: boolean; maxLanes: number };
  loads: readonly LaneLoad[];
  usedFrac: number;
  soft: number;
  hard: number;
  tuning: LaneTuning;
}

/** A machine's lane recommendation. */
export function recommendLanes(o: LaneTuningInput): LaneRecommendation {
  const { machine: m, tuning } = o;
  const usage = laneUsageBand(o.usedFrac, o.soft, o.hard);
  const base = {
    machineId: m.id, ...(m.label ? { label: m.label } : {}), online: m.online, configured: m.maxLanes, usedFrac: o.usedFrac, usage, tuning,
  };
  const stay = (reason: string): LaneRecommendation => ({ ...base, lanes: m.maxLanes, reason, confidence: 0 });
  if (!tuning.autoTune) return stay('auto-tune is off for this machine');
  if (!m.online) return stay('offline: the configured lanes stay');
  const h = laneHeadroom(o.loads.filter((l) => l.machineId === m.id));
  if (!h) return stay(`not enough history: no lane count of 1 or more ran for ${MIN_LANE_SAMPLES} minutes in the last ${LANE_TUNING_WINDOW_DAYS} days`);
  let lanes = h.lanes;
  let reason = h.why;
  if (usage !== 'free') {
    lanes = Math.min(lanes, m.maxLanes);
    const limit = usage === 'hard' ? `the hard limit ${pct(o.hard)}` : `the soft limit ${pct(o.soft)}`;
    reason += `; usage ${pct(o.usedFrac)} ${USAGE_TEXT[usage]} ${limit}: no lanes added; high-priority work keeps its lanes`;
  }
  const bounded = Math.min(tuning.maxLanes, Math.max(tuning.minLanes, lanes));
  if (bounded !== lanes) reason += `; kept within the bounds ${tuning.minLanes} to ${tuning.maxLanes}`;
  return { ...base, lanes: bounded, headroom: h.lanes, reason, confidence: Math.round(Math.min(1, h.samples / FULL_CONFIDENCE_SAMPLES) * 100) / 100 };
}
