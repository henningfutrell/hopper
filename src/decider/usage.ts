import { DEFAULT_SOFT_LANES } from '../domain/decider-policy.ts';
import type { DeciderPolicy, ExecutorLaneEffect, MachineSnapshot, UsageReading, UsageThrottle } from '../domain/types.ts';

export interface MachineUsage {
  usedFrac: number;
  /** The readings that throttle, each with its fraction; `burning`: a week window in its burn window. */
  counted: { reading: UsageReading; usedFrac: number; burning: boolean }[];
  /** Readings skipped because their limit is not positive. */
  ignored: UsageReading[];
  /** Week windows in their burn window (issue #373): their hard limit is 100% (issue #2169). */
  burning: UsageReading[];
}

/**
 * The readings of one machine: its own (machine-scoped: its own account, issue #139) when it has any
 * that throttle, else those of every machine.
 */
export function readingsOf(machineId: string, readings: UsageReading[]): UsageReading[] {
  const own = readings.filter((r) => r.machineId === machineId);
  return own.some((r) => !r.informational) ? own : readings.filter((r) => r.machineId === undefined || r.machineId === machineId);
}

/** Whether a reading limits the jobs of `executor`: one naming no executors limits every job. */
const limits = (r: UsageReading, executor: string | undefined): boolean =>
  r.executors === undefined || (executor !== undefined && r.executors.includes(executor));

/** A week window (glossary "Usage window"): `week`, `weekly`, as its source names it. */
const isWeek = (r: UsageReading): boolean => /^week/i.test(r.window ?? '');

/**
 * Where a reading stands against its reset at `at` (issue #373): `reset` — its window has reset since
 * it was read, so it says nothing now; `burn` — a week window, not spent, within `burnWindowMs` of its
 * reset: what is left would be lost at the reset, so its hard limit is 100% (issue #2169); else `keep`.
 */
export function burnPhase(r: UsageReading, at: string, burnWindowMs = 0): 'keep' | 'burn' | 'reset' {
  if (r.resetsAt === undefined) return 'keep';
  const left = Date.parse(r.resetsAt) - Date.parse(at);
  if (left <= 0) return 'reset';
  return burnWindowMs > 0 && isWeek(r) && left <= burnWindowMs && r.used < r.limit ? 'burn' : 'keep';
}

/** The non-informational readings that apply to `executor`'s jobs on the machine. */
const applicableTo = (machineId: string, readings: UsageReading[], executor: string | undefined): UsageReading[] =>
  readingsOf(machineId, readings.filter((r) => limits(r, executor))).filter((r) => !r.informational);

/**
 * Step 1: max of used/limit over every usage window of the machine (issue #2169: the session, the week, any other
 * not informational) — and, given an executor, that limit its jobs; without one, only the readings that limit every
 * job. The machine's own readings win per executor (`readingsOf`). Informational readings never apply, nor does a
 * reading whose window reset since it was read (`burnPhase`, at the decision's clock `at`). A week window in its burn
 * window counts, with 100% as its hard limit (`laneCap`).
 */
export function machineUsage(machineId: string, readings: UsageReading[], at: string, p: DeciderPolicy, executor?: string): MachineUsage {
  const live = applicableTo(machineId, readings, executor)
    .map((r) => ({ r, phase: burnPhase(r, at, p.pacing?.burnWindowMs) }))
    .filter((x) => x.phase !== 'reset');
  const ignored = live.filter((x) => x.r.limit <= 0).map((x) => x.r);
  const counted = live.filter((x) => x.r.limit > 0).map((x) => ({ reading: x.r, usedFrac: x.r.used / x.r.limit, burning: x.phase === 'burn' }));
  const burning = counted.filter((c) => c.burning).map((c) => c.reading);
  return { usedFrac: counted.length === 0 ? 0 : Math.max(...counted.map((c) => c.usedFrac)), counted, ignored, burning };
}

/**
 * Placement pressure (issue #373, glossary): the week headroom of `executor`'s account on the machine
 * — to the hard limit, or to 100% while its window burns — per hour left before that window resets.
 * The binding week window is the most used one. 0 without a week window that names its reset.
 */
export function placementPressure(machineId: string, readings: UsageReading[], at: string, p: DeciderPolicy, executor: string): number {
  const weeks = applicableTo(machineId, readings, executor)
    .filter((r) => isWeek(r) && r.limit > 0 && burnPhase(r, at, p.pacing?.burnWindowMs) !== 'reset' && r.resetsAt !== undefined);
  if (weeks.length === 0) return 0;
  const binding = weeks.reduce((a, b) => (b.used / b.limit > a.used / a.limit ? b : a));
  const ceiling = burnPhase(binding, at, p.pacing?.burnWindowMs) === 'burn' ? 1 : p.hardLimit;
  const hours = Math.max(1 / 60, (Date.parse(binding.resetsAt!) - Date.parse(at)) / 3_600_000);
  return Math.max(0, ceiling - binding.used / binding.limit) / hours;
}

export type CapBand = 'offline' | 'free' | 'soft' | 'hard';

export interface LaneCap {
  cap: number;
  band: CapBand;
  /** The usage window that sets the band (issue #2169); absent: no reading throttles. */
  throttle?: UsageThrottle;
}

/**
 * The policy on machine `m`: its own usage limits, when it has them, in place of the user's (issue #1860); its own soft
 * lanes when it names them, else the user's.
 */
export const machinePolicy = (m: Pick<MachineSnapshot, 'usageLimits'>, p: DeciderPolicy): DeciderPolicy =>
  (m.usageLimits
    ? { ...p, softLimit: m.usageLimits.soft, hardLimit: m.usageLimits.hard, ...(m.usageLimits.softLanes === undefined ? {} : { softLanes: m.usageLimits.softLanes }) }
    : p);

const BAND_RANK: Record<CapBand, number> = { offline: 0, free: 1, soft: 2, hard: 3 };

/** A reading's band at `p`: a burning week window reaches hard only when spent (issue #2169). */
function bandOf(c: MachineUsage['counted'][number], p: DeciderPolicy): Exclude<CapBand, 'offline'> {
  if (c.usedFrac < p.softLimit) return 'free';
  return c.usedFrac >= (c.burning ? 1 : p.hardLimit) ? 'hard' : 'soft';
}

const throttleOf = (c: MachineUsage['counted'][number]): UsageThrottle => ({
  source: c.reading.source, ...(c.reading.window === undefined ? {} : { window: c.reading.window }),
  usedFrac: c.usedFrac, ...(c.burning ? { burning: true as const } : {}),
});

/**
 * Step 2: the most lanes the machine may run, by its own usage limits when it has them (`machinePolicy`): every lane below
 * the soft limit, the soft lanes (at most maxLanes) from it to the hard limit, none at the hard limit (issue #2091). The
 * band is the highest of its readings' bands; its throttle is the reading that sets it, the most used of those (issue #2169).
 */
export function laneCap(m: MachineSnapshot, usage: Pick<MachineUsage, 'counted'>, policy: DeciderPolicy): LaneCap {
  if (!m.online) return { cap: 0, band: 'offline' };
  const p = machinePolicy(m, policy);
  const top = usage.counted
    .map((c) => ({ c, band: bandOf(c, p) }))
    .reduce<{ c: MachineUsage['counted'][number]; band: Exclude<CapBand, 'offline'> } | undefined>(
      (a, b) => (!a || BAND_RANK[b.band] > BAND_RANK[a.band] || (b.band === a.band && b.c.usedFrac > a.c.usedFrac) ? b : a), undefined);
  const band = top?.band ?? 'free';
  const throttle = top ? { throttle: throttleOf(top.c) } : {};
  if (band === 'free') return { cap: m.maxLanes, band, ...throttle };
  if (band === 'hard') return { cap: 0, band, ...throttle };
  return { cap: Math.min(m.maxLanes, p.softLanes ?? DEFAULT_SOFT_LANES), band, ...throttle };
}

export interface LaneEffect extends LaneCap {
  usedFrac: number;
  ignored: UsageReading[];
  burning: UsageReading[];
  executors: ExecutorLaneEffect[];
}

/**
 * Steps 1-2 per executor the machine runs, at the decision's clock `at`: each executor's jobs are
 * capped by the readings that limit them, so one agent framework's budget leaves another's jobs alone
 * (issue #140). The machine's cap is its least limited executor's — its lanes stay while any executor
 * may use them; a machine that runs no executor is capped by the readings that limit every job.
 */
export function laneEffect(m: MachineSnapshot, readings: UsageReading[], p: DeciderPolicy, at: string): LaneEffect {
  const executors = m.executors.map((executor): ExecutorLaneEffect => {
    const usage = machineUsage(m.id, readings, at, p, executor);
    return { executor, usedFrac: usage.usedFrac, ...laneCap(m, usage, p) };
  });
  const each = [undefined, ...m.executors].map((e) => machineUsage(m.id, readings, at, p, e));
  const ignored = [...new Set(each.flatMap((u) => u.ignored))];
  const burning = [...new Set(each.flatMap((u) => u.burning))];
  const least = executors.reduce<ExecutorLaneEffect | undefined>((a, b) => (!a || b.cap > a.cap || (b.cap === a.cap && b.usedFrac < a.usedFrac) ? b : a), undefined);
  if (least) {
    return { usedFrac: least.usedFrac, cap: least.cap, band: least.band, ...(least.throttle ? { throttle: least.throttle } : {}), ignored, burning, executors };
  }
  return { usedFrac: each[0]!.usedFrac, ...laneCap(m, each[0]!, p), ignored, burning, executors };
}
