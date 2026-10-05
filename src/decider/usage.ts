import type { DeciderPolicy, ExecutorLaneEffect, MachineSnapshot, UsageReading } from '../domain/types.ts';

export interface MachineUsage {
  usedFrac: number;
  /** Readings skipped because their limit is not positive. */
  ignored: UsageReading[];
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

/**
 * Step 1: max of used/limit over the readings of the machine — and, given an executor, that limit
 * its jobs; without one, only the readings that limit every job. The machine's own readings win
 * per executor (`readingsOf`). Informational readings never apply.
 */
export function machineUsage(machineId: string, readings: UsageReading[], executor?: string): MachineUsage {
  const applicable = readingsOf(machineId, readings.filter((r) => limits(r, executor))).filter((r) => !r.informational);
  const ignored = applicable.filter((r) => r.limit <= 0);
  const fracs = applicable.filter((r) => r.limit > 0).map((r) => r.used / r.limit);
  return { usedFrac: fracs.length === 0 ? 0 : Math.max(...fracs), ignored };
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
  executors: ExecutorLaneEffect[];
}

/**
 * Steps 1-2 per executor the machine runs: each executor's jobs are capped by the readings that
 * limit them, so one agent framework's budget leaves another's jobs alone (issue #140). The machine's
 * cap is its least limited executor's — its lanes stay while any executor may use them; a machine
 * that runs no executor is capped by the readings that limit every job.
 */
export function laneEffect(m: MachineSnapshot, readings: UsageReading[], p: DeciderPolicy): LaneEffect {
  const executors = m.executors.map((executor): ExecutorLaneEffect => {
    const { usedFrac } = machineUsage(m.id, readings, executor);
    return { executor, usedFrac, ...laneCap(m, usedFrac, p) };
  });
  const ignored = [...new Set([undefined, ...m.executors].flatMap((e) => machineUsage(m.id, readings, e).ignored))];
  const least = executors.reduce<ExecutorLaneEffect | undefined>((a, b) => (!a || b.cap > a.cap || (b.cap === a.cap && b.usedFrac < a.usedFrac) ? b : a), undefined);
  if (least) return { usedFrac: least.usedFrac, cap: least.cap, band: least.band, ignored, executors };
  const { usedFrac } = machineUsage(m.id, readings);
  return { usedFrac, ...laneCap(m, usedFrac, p), ignored, executors };
}
