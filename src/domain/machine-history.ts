// Machine resources over time (issue #560, design.md "Machine resources over time"): a machine's CPU, memory and
// swap as its probe last read them, each reading kept as a machine sample, and what the resource graph reads.
// Re-exported by types.ts.
import type { LaneChange } from './lane-tuning.ts';
import type { UsageGap, UsageGraphView, UsagePoint, UsageSeries } from './usage-history.ts';

/** A machine's CPU, memory and swap as last read (src/client/resources.ts is the meter; the same shape). */
export interface ResourceReading {
  /** CPUs it may use: the host's, or a container's CPU quota (may be fractional). */
  cores: number;
  /** Share of CPU time busy since the read before, 0..1. Absent: its first read. */
  cpuBusyFrac?: number;
  /**
   * Issue #2499: its **CPU throttle**, the share of CPU periods a CPU quota (`cpu.max`) of its own cgroup or one above it
   * throttled since the read before (`cpu.stat` `nr_throttled` of `nr_periods`), 0..1, the most of them. Absent: no quota,
   * its first read (an ssh target, Windows, macOS, an older client).
   */
  cpuThrottledFrac?: number;
  /** Load averages over 1, 5 and 15 minutes. Absent: Windows, which has none. */
  load?: [number, number, number];
  memTotalBytes: number;
  memAvailableBytes: number;
  /** Absent: not read (Windows, macOS, a container). */
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  /** Read inside a container's cgroup limits, not the host's. */
  container?: true;
  /** Read inside WSL (issue #868): a VM on a Windows host. */
  wsl?: true;
  /** WSL only: the memory the VM holds of the host, MemTotal less MemFree — page cache too, which Windows cannot use. */
  vmHeldBytes?: number;
  /** WSL only, with interop: the Windows host's physical memory, free and total. Absent: not read. */
  hostMemFreeBytes?: number;
  hostMemTotalBytes?: number;
  /** WSL only, a client that dials the hopper on loopback (issue #712): whether Windows reaches the hopper. Absent: not tested. */
  windowsLink?: WindowsLink;
  /** The Node version its hopper or client runs (issue #2479). Absent: not said (an ssh target, an older client). */
  node?: string;
  /** The patched floor (src/client/node-floor.ts) its Node is below: the Machines page warns. Absent: patched, or not said. */
  nodeFloor?: string;
  /**
   * Issue #2499: each job scope's memory in use, by job id (`hopper-job-<id>.scope`). A job with no lane in use there (on its
   * own wait, parked, queued to resume) still holds it: its **waiting memory**. Absent: none read (no systemd, an ssh target, an older client).
   */
  jobMemoryBytes?: Record<string, number>;
  /** Issue #2498: what each job scope used so far, by job id, and its CPU cores busy now. Absent: none read, as above. */
  jobUse?: Record<string, JobUseNow>;
  /**
   * Issue #2499: its kernel's boot id (`/proc/sys/kernel/random/boot_id`). Machines whose readings name one are on one host:
   * a **host pool**. Absent: not read (Windows, macOS, an older client).
   */
  bootId?: string;
  /** Issue #2499: under a cgroup limit (`container`), the kernel's own memory, total and available, as /proc/meminfo says. */
  kernelMemTotalBytes?: number;
  kernelMemAvailableBytes?: number;
  /**
   * Issue #2499: its **memory pressure** (PSI), as `memory.pressure` of the limited cgroup or `/proc/pressure/memory` says
   * it: the share of the last 10 s, in percent, that some task (`someAvg10`) or every task (`fullAvg10`) waited on memory.
   * Absent: not read (no PSI, Windows, macOS, an older client).
   */
  memPressure?: MemoryPressure;
  /**
   * Issue #2499: when its meter last saw a process killed for memory (an **OOM kill**): the count `oom_kill` of the limited
   * cgroup's `memory.events`, else of `/proc/vmstat`, grew since the read before. Absent: not seen (none since the meter
   * started, an ssh target, Windows, macOS, an older client).
   */
  memOomKillAt?: string;
}

/** A memory pressure reading (issue #2499): the share of the last 10 s, 0..100, that some task and every task waited on memory. */
export interface MemoryPressure { someAvg10: number; fullAvg10: number }

/**
 * What a running job's scope used so far (issue #2498), as its machine's meter read it: its peak memory (cgroup
 * `memory.peak`), its CPU time (`cpu.stat` `usage_usec`), the OOM kills in it (`memory.events` `oom_kill`), and its CPU
 * cores busy since the read before; each absent where its cgroup has none, or at its first read for the cores.
 */
export interface JobUseNow { memoryPeakBytes?: number; cpuSeconds?: number; oomKills?: number; cpuCores?: number }

/**
 * The Windows link (issue #712): what a client in WSL found when Windows, through PowerShell, opened the hopper's address
 * check (`/job/address`) at localhost, else at 127.0.0.1, at the port the client dials. `url`: the one that answered, else
 * the localhost one. `ok`: the hopper answered, with `status`; else `error` says why.
 * `mode`: WSL's networking mode (`nat`, `mirrored`), absent when not read. `at`: when it was tested.
 */
/**
 * The URLs a Windows link names (issue #712): the address check (`/job/address`) at localhost or 127.0.0.1; or the
 * health route at localhost, which a client or a keep-alive loop made before the address check still opens.
 */
export const WINDOWS_LINK_URL = /^https?:\/\/(localhost(:\d{1,5})?\/(job\/address|api\/health)|127\.0\.0\.1(:\d{1,5})?\/job\/address)$/;

export interface WindowsLink {
  url: string;
  mode?: string;
  ok: boolean;
  status?: number;
  error?: string;
  at: string;
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
  /** A WSL machine (issue #868): the memory its VM holds, and Windows' own memory, free and total, when read. */
  vmHeldBytes?: number;
  hostMemFreeBytes?: number;
  hostMemTotalBytes?: number;
  /** Issue #2499: the memory its job scopes hold for jobs with no lane in use there (waiting memory); absent, none read. */
  waitingMemBytes?: number;
  /** Issue #2499: its memory pressure (`memPressure.someAvg10`) as a share, 0..1, and its CPU throttle; absent, not read. */
  memPressureFrac?: number;
  cpuThrottledFrac?: number;
  /** Issue #2494: the hopper's own disk use there and its caches, from the sweep's last measure (at most an hour old); absent, none. */
  hopperDiskBytes?: number;
  cacheDiskBytes?: number;
  lanesBusy: number;
  lanesMax: number;
}

/**
 * What the resource graph draws per machine: each a share, 0..1. A WSL machine (issue #868) adds memory held (the memory
 * its VM holds, of its memory total) and host memory (Windows' memory used); a machine with PSI or a CPU quota (issue
 * #2499) its memory pressure and its CPU throttle; a machine the sweep measured (issue #2494) the hopper's own disk use
 * and its caches, each of its disk total.
 */
export const MACHINE_RESOURCES = ['cpu', 'memory', 'held', 'host', 'swap', 'disk', 'lanes', 'pressure', 'throttle', 'hopper', 'caches'] as const;
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
  /**
   * One machine's graph only (issue #688, lane tuning's graph): the usage that limits it — the lines of its own usage
   * readings and of a budget every machine shares — at the resource step.
   */
  usage?: UsageSeries[];
  /** One machine's graph only: its lane changes in the range, oldest first. */
  laneChanges?: LaneChange[];
  /** The memory alert (issue #868); absent: off. */
  memoryAlert?: MemoryAlert;
}

/**
 * The memory alert (issue #868): a person is told (`machine.memory_low`) when a machine's free memory stays under
 * `freeBytes` for `minutes` (0: at the first reading under), and again (`machine.memory_recovered`) when it is back over.
 * The free memory is Windows' own for a WSL machine that reads it, else memory available. The user's setting, an admin's to change.
 */
export interface MemoryAlert {
  freeBytes: number;
  minutes: number;
}

/** The longest a memory alert waits: a day. */
export const MAX_MEMORY_ALERT_MINUTES = 1440;

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
