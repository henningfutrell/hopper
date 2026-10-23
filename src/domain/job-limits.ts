// A machine's limits for each job (issue #2498, design.md "The job's scope"): set on the job's scope as it is made, so a job
// past its memory limit is stopped by the OOM killer in its own scope, and the machine's other work goes on.
// Issue #2622: with no `jobMemoryMaxGiB`, each job still gets a default memory limit, so one burst of builds cannot take the
// whole host; and MemoryHigh below MemoryMax, so the kernel reclaims and slows a job before the OOM killer stops it. Part 7:
// on a host pool (seats on one WSL kernel) the default shares the kernel's memory by every lane of the pool, not by its own.
import { MEMORY_FLOOR_MIN_GIB, MEMORY_FLOOR_PERCENT, MEMORY_PER_JOB_GIB } from './memory-floor.ts';
import type { MachineSnapshot } from './types.ts';

/** A machine's own job limits (its `jobMemoryMaxGiB` and `jobCpuPercent` options). Absent fields: no limit. */
export interface JobLimits { memoryMaxGiB?: number; cpuPercent?: number }

/** MemoryHigh, as this share of MemoryMax. */
export const MEMORY_HIGH_SHARE = 0.9;

const GIB = 1024 ** 3;

/** Memory of `total` GiB less its floor (`own`, else 10% and at least 1 GiB), shared by `lanes`, in GiB. */
const shareOf = (total: number, lanes: number, own?: number): number =>
  (total - (own ?? Math.max(MEMORY_FLOOR_MIN_GIB, (total * MEMORY_FLOOR_PERCENT) / 100))) / lanes;

/**
 * The limits a job's scope on machine `m` is made with: its own job limits, and with no `jobMemoryMaxGiB` the default memory
 * limit — its memory less its memory floor (its own, else 10% and at least 1 GiB), shared by its lanes, to 0.1 GiB, and never
 * less than a job's memory. On a host pool (part 7) the kernel's memory less its floor, shared by every lane of the pool, when
 * that is less. No memory limit with no memory reading or no lanes. Undefined: no limit at all.
 */
export function scopeLimitsOf(m: Pick<MachineSnapshot, 'jobLimits' | 'resources' | 'maxLanes' | 'memoryFloor' | 'hostPool'>): JobLimits | undefined {
  const total = (m.resources?.memTotalBytes ?? 0) / GIB;
  const pool = m.hostPool && m.hostPool.lanes > 0 ? shareOf(m.hostPool.memTotalBytes / GIB, m.hostPool.lanes) : Infinity;
  const share = Math.max(m.memoryFloor?.perJobGiB ?? MEMORY_PER_JOB_GIB, Math.round(Math.min(shareOf(total, m.maxLanes, m.memoryFloor?.floorGiB), pool) * 10) / 10);
  const memoryMaxGiB = m.jobLimits?.memoryMaxGiB ?? (total > 0 && m.maxLanes > 0 ? share : undefined);
  const limits = { ...(memoryMaxGiB !== undefined ? { memoryMaxGiB } : {}), ...(m.jobLimits?.cpuPercent !== undefined ? { cpuPercent: m.jobLimits.cpuPercent } : {}) };
  return Object.keys(limits).length ? limits : undefined;
}

/**
 * The systemd properties of the limits, for `systemd-run -p`: `MemoryMax` and `MemoryHigh` (`MEMORY_HIGH_SHARE` of it) in
 * bytes, `CPUQuota` in percent of one CPU.
 */
export function scopeLimitProperties(l: JobLimits | undefined): string[] {
  return [
    ...(l?.memoryMaxGiB !== undefined ? [`MemoryMax=${Math.round(l.memoryMaxGiB * GIB)}`, `MemoryHigh=${Math.round(l.memoryMaxGiB * GIB * MEMORY_HIGH_SHARE)}`] : []),
    ...(l?.cpuPercent !== undefined ? [`CPUQuota=${Math.round(l.cpuPercent)}%`] : []),
  ];
}
