// Lane tuning (issue #688, design.md "Lane tuning"): the deterministic rules. Lane headroom from a machine's lane
// load and lane progress — the most lanes in use its history shows without resource pressure or slow progress, plus what
// each lane's measured cost leaves room for —, and the lane recommendation: the headroom below the soft limit, never more than the configured lanes near it
// or past it, never more than its memory holds (issue #2499), within the machine's bounds. What an admin can do with a recommendation: apply it, undo the last one
// applied; a dismissed one is not offered again until it moves. Pure, like the rest of the decider.
import {
  LANE_TUNING_WINDOW_DAYS, type JobRun, type LaneChange, type LaneDismissal, type LaneLoad, type LaneProgress, type LaneRecommendation, type LaneTuning,
  type LaneUsageBand,
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
/** A lane count's runs show slow progress only when this many ended there, and as many at fewer lanes (1 or more). */
export const MIN_PROGRESS_RUNS = 4;
/** Slow progress: the share of runs that failed is more than this above the share at fewer lanes. */
export const FAILURE_RISE = 0.25;
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

/** Lane progress from job runs: per machine and lane count, the runs that ended `finished` or `failed`; a run with no sample has no lane count. */
export function laneProgress(runs: readonly JobRun[]): LaneProgress[] {
  const out = new Map<string, LaneProgress>();
  for (const r of runs) {
    if ((r.end !== 'finished' && r.end !== 'failed') || r.lanesBusyAvg === undefined) continue;
    const lanesBusy = Math.max(1, Math.round(r.lanesBusyAvg));
    const key = `${r.machineId}\u0000${lanesBusy}`;
    const p = out.get(key) ?? { machineId: r.machineId, lanesBusy, runs: 0, failed: 0 };
    out.set(key, { ...p, runs: p.runs + 1, failed: p.failed + (r.end === 'failed' ? 1 : 0) });
  }
  return [...out.values()].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : a.lanesBusy - b.lanesBusy));
}

interface SlowProgress { at: LaneProgress; below: { runs: number; failed: number } }

/** The first lane count whose runs fail more than FAILURE_RISE more often than the runs at fewer lanes, each on MIN_PROGRESS_RUNS runs. */
function slowProgress(progress: readonly LaneProgress[]): SlowProgress | undefined {
  const sorted = [...progress].sort((a, b) => a.lanesBusy - b.lanesBusy);
  for (const at of sorted) {
    const below = sorted.filter((p) => p.lanesBusy < at.lanesBusy).reduce((t, p) => ({ runs: t.runs + p.runs, failed: t.failed + p.failed }), { runs: 0, failed: 0 });
    if (at.runs < MIN_PROGRESS_RUNS || below.runs < MIN_PROGRESS_RUNS) continue;
    if (at.failed / at.runs - below.failed / below.runs > FAILURE_RISE) return { at, below };
  }
  return undefined;
}

/** How many lanes of `perLane` fit between `used` and `target` (a lane that costs nothing measured: no limit). */
function room(used: number | undefined, base: number | undefined, span: number, target: number | undefined): number {
  if (used === undefined || base === undefined || target === undefined) return MAX_LANE_STEP;
  const perLane = (used - base) / span;
  return perLane <= 0 ? MAX_LANE_STEP : Math.floor((target - used) / perLane + 1e-9);
}

/**
 * Lane headroom from a machine's lane load and lane progress: one less than the first lane count with resource pressure
 * or slow progress (slow progress first at the same count). Undefined when no lane count of 1 or more ran for MIN_LANE_SAMPLES.
 */
export function laneHeadroom(loads: readonly LaneLoad[], progress: readonly LaneProgress[] = []): LaneHeadroom | undefined {
  const counted = loads.filter((l) => l.samples >= MIN_LANE_SAMPLES).sort((a, b) => a.lanesBusy - b.lanesBusy);
  if (!counted.some((l) => l.lanesBusy >= 1)) return undefined;
  const first = counted.find((l) => l.lanesBusy >= 1 && pressured(l));
  const slow = slowProgress(progress);
  if (slow && (!first || slow.at.lanesBusy <= first.lanesBusy)) {
    const lanes = slow.at.lanesBusy - 1;
    return {
      lanes, samples: counted.filter((l) => l.lanesBusy < slow.at.lanesBusy).at(-1)?.samples ?? 0,
      why: `slow progress at ${slow.at.lanesBusy} lanes in use (${slow.at.failed} of ${slow.at.runs} runs failed; `
        + `${slow.below.failed} of ${slow.below.runs} at fewer lanes): ${lanesText(lanes)} run${lanes === 1 ? 's' : ''} without it`,
    };
  }
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
  progress: readonly LaneProgress[];
  usedFrac: number;
  soft: number;
  hard: number;
  tuning: LaneTuning;
  /** Issue #2499: how many jobs the machine's memory holds (`memoryLaneCaps`); absent: not known. */
  memory?: { lanes: number; why: string };
}

const clamp = (n: number, t: LaneTuning): number => Math.min(t.maxLanes, Math.max(t.minLanes, n));

/**
 * What an admin can do with a recommendation now. `apply`: it differs from the configured lanes and stands on a known
 * headroom, with auto-tune on and the machine online, and was not dismissed. `dismissed`: an admin dismissed these lanes
 * at these configured lanes. `undo`: the machine's last lane change was an applied recommendation, and the configured
 * lanes are still its lanes — a hand edit since stands.
 */
export function laneActions(r: LaneRecommendation, dismissal: LaneDismissal | undefined, last: LaneChange | undefined): Pick<LaneRecommendation, 'apply' | 'dismissed' | 'undo'> {
  const open = r.tuning.autoTune && r.online && r.headroom !== undefined && r.lanes !== r.configured;
  const dismissed = open && dismissal?.lanes === r.lanes && dismissal.configured === r.configured;
  return {
    ...(open && !dismissed ? { apply: { to: r.lanes } } : {}),
    ...(dismissed ? { dismissed: { at: dismissal.at, by: dismissal.by } } : {}),
    ...(last?.kind === 'applied' && last.machineId === r.machineId && last.to === r.configured ? { undo: { to: last.from } } : {}),
  };
}

/** A machine's lane recommendation. */
export function recommendLanes(o: LaneTuningInput): LaneRecommendation {
  const { machine: m, tuning } = o;
  const usage = laneUsageBand(o.usedFrac, o.soft, o.hard);
  const base = { machineId: m.id, ...(m.label ? { label: m.label } : {}), online: m.online, configured: m.maxLanes, usedFrac: o.usedFrac, usage, tuning };
  const stay = (reason: string): LaneRecommendation => ({ ...base, lanes: m.maxLanes, reason, confidence: 0 });
  if (!tuning.autoTune) return stay('auto-tune is off for this machine');
  if (!m.online) return stay('offline: the configured lanes stay');
  const h = laneHeadroom(o.loads.filter((l) => l.machineId === m.id), o.progress.filter((p) => p.machineId === m.id));
  if (!h) return stay(`not enough history: no lane count of 1 or more ran for ${MIN_LANE_SAMPLES} minutes in the last ${LANE_TUNING_WINDOW_DAYS} days`);
  let lanes = h.lanes;
  let reason = h.why;
  if (usage !== 'free') {
    lanes = Math.min(lanes, m.maxLanes);
    const limit = usage === 'hard' ? `the hard limit ${pct(o.hard)}` : `the soft limit ${pct(o.soft)}`;
    reason += `; usage ${pct(o.usedFrac)} ${USAGE_TEXT[usage]} ${limit}: no lanes added; high-priority work keeps its lanes`;
  }
  if (o.memory && o.memory.lanes < lanes) {
    lanes = o.memory.lanes;
    reason += `; ${o.memory.why}: no more than ${lanesText(lanes)}`;
  }
  const bounded = clamp(lanes, tuning);
  if (bounded !== lanes) reason += `; kept within the bounds ${tuning.minLanes} to ${tuning.maxLanes}`;
  return { ...base, lanes: bounded, headroom: h.lanes, reason, confidence: Math.round(Math.min(1, h.samples / FULL_CONFIDENCE_SAMPLES) * 100) / 100 };
}
