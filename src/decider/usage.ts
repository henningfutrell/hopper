import type { DeciderPolicy, ExecutorLaneEffect, MachineSnapshot, UsageReading } from '../domain/types.ts';

export interface MachineUsage {
  usedFrac: number;
  /** Readings skipped because their limit is not positive. */
  ignored: UsageReading[];
  /** Week windows skipped because they are in their burn window (issue #373). */
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
 * reset: what is left would be lost at the reset, so it does not throttle; else `keep`.
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
 * Step 1: max of used/limit over the readings of the machine — and, given an executor, that limit
 * its jobs; without one, only the readings that limit every job. The machine's own readings win
 * per executor (`readingsOf`). Informational readings never apply, nor does a reading whose window
 * reset since it was read or one in its burn window (`burnPhase`, at the decision's clock `at`).
 */
export function machineUsage(machineId: string, readings: UsageReading[], at: string, p: DeciderPolicy, executor?: string): MachineUsage {
  const applicable = applicableTo(machineId, readings, executor);
  const burning = applicable.filter((r) => burnPhase(r, at, p.pacing?.burnWindowMs) === 'burn');
  const kept = applicable.filter((r) => burnPhase(r, at, p.pacing?.burnWindowMs) === 'keep');
  const ignored = kept.filter((r) => r.limit <= 0);
  const fracs = kept.filter((r) => r.limit > 0).map((r) => r.used / r.limit);
  return { usedFrac: fracs.length === 0 ? 0 : Math.max(...fracs), ignored, burning };
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
}

/** Step 2: the most lanes the machine may run. */
export function laneCap(m: MachineSnapshot, usedFrac: number, p: DeciderPolicy): LaneCap {
  if (!m.online) return { cap: 0, band: 'offline' };
  if (usedFrac < p.softLimit) return { cap: m.maxLanes, band: 'free' };
  if (usedFrac >= p.hardLimit) return { cap: 0, band: 'hard' };
  const scaled = (m.maxLanes * (p.hardLimit - usedFrac)) / (p.hardLimit - p.softLimit);
  return { cap: Math.max(0, Math.floor(scaled + 1e-9)), band: 'soft' };
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
    const { usedFrac } = machineUsage(m.id, readings, at, p, executor);
    return { executor, usedFrac, ...laneCap(m, usedFrac, p) };
  });
  const each = [undefined, ...m.executors].map((e) => machineUsage(m.id, readings, at, p, e));
  const ignored = [...new Set(each.flatMap((u) => u.ignored))];
  const burning = [...new Set(each.flatMap((u) => u.burning))];
  const least = executors.reduce<ExecutorLaneEffect | undefined>((a, b) => (!a || b.cap > a.cap || (b.cap === a.cap && b.usedFrac < a.usedFrac) ? b : a), undefined);
  if (least) return { usedFrac: least.usedFrac, cap: least.cap, band: least.band, ignored, burning, executors };
  const { usedFrac } = each[0]!;
  return { usedFrac, ...laneCap(m, usedFrac, p), ignored, burning, executors };
}
