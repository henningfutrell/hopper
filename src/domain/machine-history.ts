// Machine resources over time (issue #560, design.md "Machine resources over time"): a machine's CPU, memory and
// swap as its probe last read them, each reading kept as a machine sample, and what the resource graph reads.
// Re-exported by types.ts.
import type { UsageGap, UsageGraphView, UsagePoint } from './usage-history.ts';

/** A machine's CPU, memory and swap as last read (src/client/resources.ts is the meter; the same shape). */
export interface ResourceReading {
  /** CPUs it may use: the host's, or a container's CPU quota (may be fractional). */
  cores: number;
  /** Share of CPU time busy since the read before, 0..1. Absent: its first read. */
  cpuBusyFrac?: number;
  /** Load averages over 1, 5 and 15 minutes. Absent: Windows, which has none. */
  load?: [number, number, number];
  memTotalBytes: number;
  memAvailableBytes: number;
  /** Absent: not read (Windows, macOS, a container). */
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  /** Read inside a container's cgroup limits, not the host's. */
  container?: true;
}

/** One machine's resources and disk at one time, with its lanes in use: what the resource recorder keeps. */
export interface MachineSample {
  machineId: string;
  at: string;
  cores?: number;
  cpuBusyFrac?: number;
  load1?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  lanesBusy: number;
  lanesMax: number;
}

/** What the resource graph draws per machine: each a share, 0..1. */
export const MACHINE_RESOURCES = ['cpu', 'memory', 'swap', 'disk', 'lanes'] as const;
export type MachineResource = typeof MACHINE_RESOURCES[number];

/** One line of the resource graph: one machine's resource, per graph step its peak share; the gaps where the machine gave no sample. */
export interface ResourceSeries {
  machineId: string;
  resource: MachineResource;
  points: UsagePoint[];
  gaps: UsageGap[];
}

/** `GET /api/machines/history` and `GET /api/machines/:id/history`: the resource graph. */
export interface MachineHistory {
  view: UsageGraphView;
  from: string;
  to: string;
  stepMs: number;
  /** The history retention, shared with the usage samples. */
  retentionDays: number;
  series: ResourceSeries[];
}

/** The resource graph's default range: a day. */
export const DEFAULT_MACHINE_GRAPH_VIEW: UsageGraphView = { range: { preset: '24h' } };

/**
 * The resource graph's step for a stretch this long: finer than the usage graph's, since a machine is read every
 * minute — 15 minutes up to a day, an hour up to four, six hours up to two weeks, a day up to sixty, else a week.
 */
export function resourceStepMs(spanMs: number): number {
  const days = spanMs / 86_400_000;
  const h = 3_600_000;
  return days <= 1 ? h / 4 : days <= 4 ? h : days <= 14 ? 6 * h : days <= 60 ? 24 * h : 168 * h;
}
