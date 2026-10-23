// A machine's resources (issue #560, design.md "Machine resources over time"): its CPU, memory and swap as this
// process reads them, for this machine's snapshot and a client target's `/release` answer. CPU busy is the share of
// CPU time busy between this read and the one before (none at the first read, and a read sooner than a second after
// the last keeps the last); memory is what is available, not what is free. On Linux memory and swap come from
// /proc/meminfo; elsewhere (Windows, macOS) from the OS, with no swap. A process in a container whose cgroup (v2)
// sets limits reads its limits and its own use: a memory limit as its total, a CPU quota as its cores. The memory limit
// may sit on a cgroup above the process's own (issue #2499): a seat's container, or a systemd unit's MemoryMax.
// In WSL (issue #868) the VM keeps its page cache, which Windows cannot use: the meter adds the memory the VM holds
// (MemTotal less MemFree) and, through WSL interop, Windows' own free memory, read in the background once a minute.
// In a Kubernetes pod (issue #1289) it is never WSL, whatever the node's kernel, and always a container: its limits are
// the cgroup's, else the pod's own through the Downward API (src/client/cluster.ts).
// Imports nothing of hopper: a client target runs it as a plain file.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { availableParallelism, cpus, freemem, homedir, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { inCluster, podLimits, type Env } from './cluster.ts';
import { nodeFloorOf } from './node-floor.ts';

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
  /** Read inside WSL (issue #868): a VM on a Windows host. */
  wsl?: true;
  /** WSL only: the memory the VM holds of the host, MemTotal less MemFree — page cache too, which Windows cannot use. */
  vmHeldBytes?: number;
  /** WSL only, with interop: the Windows host's physical memory, free and total. Absent: not read. */
  hostMemFreeBytes?: number;
  hostMemTotalBytes?: number;
  /** The Node version this process runs (issue #2479), as `process.version` says it. */
  node?: string;
  /** The patched floor (node-floor.ts) its Node is below. Absent: patched. */
  nodeFloor?: string;
}

/** A host's physical memory, free and total. */
export interface HostMemory { freeBytes: number; totalBytes: number }
/** Reads the Windows host's memory from inside WSL; undefined when it cannot (no interop). */
export type HostMemoryReader = () => Promise<HostMemory | undefined>;

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
  /** WSL only: reads the Windows host's memory; default PowerShell through interop. */
  hostMemory?: HostMemoryReader;
  /** Says whether it runs in a Kubernetes pod, and the pod's limits; default this process's. */
  env?: Env;
  /** The Node version it runs; default this process's. */
  node?: string;
}

/** How often the Windows host's memory is read again, at most. */
const HOST_INTERVAL_MS = 60_000;
/** A host reading older than this is dropped: the host no longer answers. */
const HOST_STALE_MS = 5 * 60_000;

/** Windows' free and total physical memory in KiB, as one line: `<free> <total>`. */
const WINDOWS_MEMORY = '$o = Get-CimInstance Win32_OperatingSystem; "$($o.FreePhysicalMemory) $($o.TotalVisibleMemorySize)"';
/** Where powershell.exe is when the Windows path is not on PATH (interop with `appendWindowsPath=false`). */
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Windows' answer to WINDOWS_MEMORY; undefined when it is not two sane numbers. */
export function readWindowsMemory(stdout: string): HostMemory | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  if (!m) return undefined;
  const free = Number(m[1]) * 1024;
  const total = Number(m[2]) * 1024;
  return total > 0 && free <= total ? { freeBytes: free, totalBytes: total } : undefined;
}

/** Runs a PowerShell script through WSL interop: powershell.exe on PATH, else at its usual place; its stdout, or undefined when it did not run. */
export async function powershell(script: string, timeoutMs = 20_000): Promise<string | undefined> {
  const run = (cmd: string) => new Promise<string | undefined>((resolve) => {
    execFile(cmd, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
  return (await run('powershell.exe')) ?? (existsSync(POWERSHELL_PATH) ? await run(POWERSHELL_PATH) : undefined);
}

/** Windows' memory through WSL interop. */
const windowsMemory: HostMemoryReader = async () => {
  const out = await powershell(WINDOWS_MEMORY);
  return out === undefined ? undefined : readWindowsMemory(out);
};

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
  const env = d.env ?? process.env;
  const pod = inCluster(env) ? podLimits(env) : undefined;
  const wsl = !pod && platform === 'linux' && /microsoft/i.test(text(join(root, 'proc/version')) ?? '');
  const hostMemory = d.hostMemory ?? windowsMemory;
  const node = d.node ?? process.version;
  const nodeFloor = nodeFloorOf(node);
  let host: { at: number; reading: HostMemory } | undefined;
  let hostAskedAt: number | undefined;
  let hostAsking = false;

  /** The Windows host's memory as last read, and a new read in the background when a minute has gone. */
  const hostNow = (at: number): Pick<ResourceReading, 'hostMemFreeBytes' | 'hostMemTotalBytes'> => {
    if (!hostAsking && (hostAskedAt === undefined || at - hostAskedAt >= HOST_INTERVAL_MS)) {
      hostAsking = true;
      hostAskedAt = at;
      hostMemory().then((r) => { if (r) host = { at: hostAskedAt!, reading: r }; }, () => {}).finally(() => { hostAsking = false; });
    }
    if (!host || at - host.at > HOST_STALE_MS) return {};
    return { hostMemFreeBytes: host.reading.freeBytes, hostMemTotalBytes: host.reading.totalBytes };
  };

  /** The container's CPU quota in cores, when its cgroup sets one; else a pod's CPU limit. */
  const quota = (): number | undefined => {
    if (platform !== 'linux') return undefined;
    const [q, period] = (text(cgroup('cpu.max')) ?? '').trim().split(/\s+/);
    return q && /^\d+$/.test(q) && period && Number(period) > 0 ? Number(q) / Number(period) : pod?.cores;
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

  /**
   * Issue #2499: the memory limit of its own cgroup or one above it, as /proc/self/cgroup names it — a seat's container
   * seen from the host's cgroup namespace, or a systemd unit's MemoryMax — the tightest, with that cgroup's use; at the
   * root, a pod's limit through the Downward API. The page cache it could drop is available, as MemAvailable counts it.
   */
  const cgroupMemory = (): { memTotalBytes: number; memAvailableBytes: number } | undefined => {
    const own = /^0::(\/.*)$/m.exec(text(join(root, 'proc/self/cgroup')) ?? '')?.[1] ?? '/';
    const parts = own.split('/').filter(Boolean);
    let tightest: { memTotalBytes: number; memAvailableBytes: number } | undefined;
    for (let n = parts.length; n >= 0; n -= 1) {
      const dir = parts.slice(0, n).join('/');
      const max = limit(cgroup(join(dir, 'memory.max'))) ?? (n === 0 ? pod?.memBytes : undefined);
      const current = max !== undefined ? limit(cgroup(join(dir, 'memory.current'))) : undefined;
      if (max === undefined || current === undefined) continue;
      const used = Math.max(0, current - (fields(text(cgroup(join(dir, 'memory.stat')))).get('inactive_file') ?? 0));
      const available = Math.max(0, max - used);
      if (!tightest || available < tightest.memAvailableBytes) tightest = { memTotalBytes: max, memAvailableBytes: available };
    }
    return tightest;
  };

  const memory = (): Pick<ResourceReading, 'memTotalBytes' | 'memAvailableBytes' | 'swapTotalBytes' | 'swapUsedBytes' | 'container' | 'vmHeldBytes'> => {
    const limited = platform === 'linux' ? cgroupMemory() : undefined;
    if (limited) return { ...limited, container: true };
    const info = platform === 'linux' ? fields(text(join(root, 'proc/meminfo'))) : new Map<string, number>();
    const kib = (k: string) => (info.has(k) ? info.get(k)! * 1024 : undefined);
    const total = kib('MemTotal');
    const available = kib('MemAvailable');
    const swapTotal = kib('SwapTotal');
    const swapFree = kib('SwapFree');
    const free = kib('MemFree');
    return {
      memTotalBytes: total ?? (d.totalmem ?? totalmem)(),
      memAvailableBytes: available ?? (d.freemem ?? freemem)(),
      ...(wsl && total !== undefined && free !== undefined ? { vmHeldBytes: Math.max(0, total - free) } : {}),
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
      ...(q !== undefined || pod ? { container: true as const } : {}),
      ...(wsl ? { wsl: true as const, ...hostNow(at) } : {}),
      node, ...(nodeFloor ? { nodeFloor } : {}),
    };
  };
}

/** The disk this user's home is on (issue #401), for the hopper's warning before it fills; none when it cannot be read. */
export function diskOfHome(): { disk?: { freeBytes: number; totalBytes: number } } {
  try {
    const s = statfsSync(homedir());
    return { disk: { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize } };
  } catch {
    return {};
  }
}
