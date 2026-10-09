// A machine's resources (issue #560, design.md "Machine resources over time"): its CPU, memory and swap as this
// process reads them, for this machine's snapshot and a client target's `/release` answer. CPU busy is the share of
// CPU time busy between this read and the one before (none at the first read, and a read sooner than a second after
// the last keeps the last); memory is what is available, not what is free. On Linux memory and swap come from
// /proc/meminfo; elsewhere (Windows, macOS) from the OS, with no swap. A process in a container whose cgroup (v2)
// sets limits reads its limits and its own use: a memory limit as its total, a CPU quota as its cores.
// Imports nothing of hopper: a client target runs it as a plain file.
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

export interface ResourceReading {
  /** CPUs it may use: the host's, or a container's CPU quota (may be fractional). */
  cores: number;
  /** Share of CPU time busy since the read before, 0..1. Absent: the first read. */
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

export interface CpuTimes { user: number; nice: number; sys: number; idle: number; irq: number }

export interface ResourceMeterDeps {
  /** Where /proc and /sys/fs/cgroup are found; default `/`. */
  root?: string;
  platform?: string;
  now?: () => number;
  cpus?: () => CpuTimes[];
  parallelism?: () => number;
  loadavg?: () => number[];
  totalmem?: () => number;
  freemem?: () => number;
}

/** A read sooner than this after the last keeps the last CPU busy: the share over a few ms is noise. */
const MIN_CPU_INTERVAL_MS = 1000;

const text = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** A number in a cgroup file (`max`, absent or unreadable: none). */
const limit = (path: string): number | undefined => {
  const v = text(path)?.trim().split(/\s+/)[0];
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
};

/** `key value` lines (cgroup `*.stat`) or `Key: value kB` lines (/proc/meminfo), as numbers. */
function fields(t: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of (t ?? '').split('\n')) {
    const m = /^(\w+):?\s+(\d+)/.exec(line);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** A meter: each call reads the machine now. Keeps the last CPU times, so each read's CPU busy is over the time between. */
export function createResourceMeter(d: ResourceMeterDeps = {}): () => ResourceReading {
  const root = d.root ?? '/';
  const platform = d.platform ?? process.platform;
  const now = d.now ?? Date.now;
  const cgroup = (name: string) => join(root, 'sys/fs/cgroup', name);
  let last: { at: number; busy: number; total: number } | undefined;
  let busyFrac: number | undefined;

  /** The container's CPU quota in cores, when its cgroup sets one. */
  const quota = (): number | undefined => {
    if (platform !== 'linux') return undefined;
    const [q, period] = (text(cgroup('cpu.max')) ?? '').trim().split(/\s+/);
    return q && /^\d+$/.test(q) && period && Number(period) > 0 ? Number(q) / Number(period) : undefined;
  };

  /** Busy and total CPU time so far, in comparable units: the cgroup's own use against its quota, else the host's CPUs. */
  const cpuTimes = (cores: number | undefined, at: number): { busy: number; total: number } => {
    if (cores !== undefined) {
      const used = fields(text(cgroup('cpu.stat'))).get('usage_usec') ?? 0;
      return { busy: used / 1000, total: at * cores };
    }
    let busy = 0;
    let total = 0;
    for (const c of (d.cpus ?? (() => cpus().map((x) => x.times)))()) {
      busy += c.user + c.nice + c.sys + c.irq;
      total += c.user + c.nice + c.sys + c.irq + c.idle;
    }
    return { busy, total };
  };

  const memory = (): Pick<ResourceReading, 'memTotalBytes' | 'memAvailableBytes' | 'swapTotalBytes' | 'swapUsedBytes' | 'container'> => {
    const max = platform === 'linux' ? limit(cgroup('memory.max')) : undefined;
    const current = max !== undefined ? limit(cgroup('memory.current')) : undefined;
    if (max !== undefined && current !== undefined) {
      // The page cache it could drop is available, as MemAvailable counts it on the host.
      const used = Math.max(0, current - (fields(text(cgroup('memory.stat'))).get('inactive_file') ?? 0));
      return { memTotalBytes: max, memAvailableBytes: Math.max(0, max - used), container: true };
    }
    const info = platform === 'linux' ? fields(text(join(root, 'proc/meminfo'))) : new Map<string, number>();
    const kib = (k: string) => (info.has(k) ? info.get(k)! * 1024 : undefined);
    const total = kib('MemTotal');
    const available = kib('MemAvailable');
    const swapTotal = kib('SwapTotal');
    const swapFree = kib('SwapFree');
    return {
      memTotalBytes: total ?? (d.totalmem ?? totalmem)(),
      memAvailableBytes: available ?? (d.freemem ?? freemem)(),
      ...(swapTotal !== undefined && swapFree !== undefined ? { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) } : {}),
    };
  };

  return () => {
    const at = now();
    const q = quota();
    if (!last || at - last.at >= MIN_CPU_INTERVAL_MS) {
      const t = cpuTimes(q, at);
      if (last && t.total > last.total) busyFrac = clamp((t.busy - last.busy) / (t.total - last.total));
      last = { at, ...t };
    }
    const mem = memory();
    const l = (d.loadavg ?? loadavg)();
    return {
      cores: q ?? (d.parallelism ?? availableParallelism)(),
      ...(busyFrac !== undefined ? { cpuBusyFrac: busyFrac } : {}),
      ...(platform !== 'win32' && l.length === 3 ? { load: [l[0]!, l[1]!, l[2]!] as [number, number, number] } : {}),
      ...mem,
      ...(q !== undefined ? { container: true as const } : {}),
    };
  };
}
