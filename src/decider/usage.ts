import type { DeciderPolicy, MachineSnapshot, UsageReading } from '../domain/types.ts';

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

/** Step 1: max of used/limit over the readings of the machine; informational readings never count. */
export function machineUsage(machineId: string, readings: UsageReading[]): MachineUsage {
  const applicable = readingsOf(machineId, readings).filter((r) => !r.informational);
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
