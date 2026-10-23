// A machine's resources (issue #560, design.md "Machine resources over time"): its CPU, memory and swap as this
// process reads them, for this machine's snapshot and a client target's `/release` answer. CPU busy is the share of
// CPU time busy between this read and the one before (none at the first read, and a read sooner than a second after
// the last keeps the last); memory is what is available, not what is free. On Linux memory and swap come from
// /proc/meminfo; elsewhere (Windows, macOS) from the OS, with no swap. A process in a container whose cgroup (v2)
// sets limits reads its limits and its own use: a memory limit as its total, a CPU quota as its cores. The memory limit
// may sit on a cgroup above the process's own (issue #2499): a seat's container, or a systemd unit's MemoryMax.
// Each job scope's memory is read too (issue #2499): one outside the limited cgroup is taken off its memory available.
// It names its kernel by its boot id and, under a cgroup limit, says the kernel's own memory (issue #2499): the hopper
// counts the machines on one host as one pool. It says its memory pressure (PSI): the limited cgroup's, else the kernel's,
// and when it last saw a process killed for memory (an OOM kill): the limited cgroup's memory.events, else /proc/vmstat.
// It says the share of CPU periods a CPU quota throttled (issue #2499): its own cgroup's or one above it, the most of them.
// In WSL (issue #868) the VM keeps its page cache, which Windows cannot use: the meter adds the memory the VM holds
// (MemTotal less MemFree) and, through WSL interop, Windows' own free memory, read in the background once a minute.
// In a Kubernetes pod (issue #1289) it is never WSL, whatever the node's kernel, and always a container: its limits are
// the cgroup's, else the pod's own through the Downward API (src/client/cluster.ts).
// Imports nothing of hopper: a client target runs it as a plain file.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { availableParallelism, cpus, freemem, homedir, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { inCluster, podLimits, type Env } from './cluster.ts';
import { nodeFloorOf } from './node-floor.ts';

export interface ResourceReading {
  /** CPUs it may use: the host's, or a container's CPU quota (may be fractional). */
  cores: number;
  /** Share of CPU time busy since the read before, 0..1. Absent: the first read. */
  cpuBusyFrac?: number;
  /** Issue #2499: the share of CPU periods a cgroup's quota throttled since the read before, 0..1, the most of its cgroups. Absent: no quota, or the first read. */
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
  /** The Node version this process runs (issue #2479), as `process.version` says it. */
  node?: string;
  /** The patched floor (node-floor.ts) its Node is below. Absent: patched. */
  nodeFloor?: string;
  /** Issue #2499: each job scope's memory in use (`hopper-job-<id>.scope`, less the page cache it could drop). Absent: none read. */
  jobMemoryBytes?: Record<string, number>;
  /** Issue #2498: what each job scope used so far, and its CPU cores busy since the read before. Absent: none read. */
  jobUse?: Record<string, JobUseNow>;
  /** Issue #2499: its kernel's boot id, so machines on one host are one pool. Absent: not read. */
  bootId?: string;
  /** Issue #2499: under a cgroup limit, the kernel's own memory (/proc/meminfo), total and available. */
  kernelMemTotalBytes?: number;
  kernelMemAvailableBytes?: number;
  /** Issue #2499: the share of the last 10 s, in percent, that some task and every task waited on memory (PSI). Absent: not read. */
  memPressure?: { someAvg10: number; fullAvg10: number };
  /** Issue #2499: when this meter last saw its OOM kill count grow (memory.events `oom_kill`, else /proc/vmstat). Absent: not seen. */
  memOomKillAt?: string;
  /** Issue #2622: what holds its jobs' memory: each job's scope, a cgroup limit over it, or nothing. Absent: not Linux. */
  jobMemoryLimit?: 'scope' | 'machine' | 'none';
}

/**
 * What a running job's scope used so far (issue #2498): its peak memory (cgroup `memory.peak`), its CPU time (`cpu.stat`
 * `usage_usec`), the OOM kills in it (`memory.events` `oom_kill`), and its CPU cores busy since the read before (none at
 * its first read); each absent where its cgroup has none.
 */
export interface JobUseNow { memoryPeakBytes?: number; cpuSeconds?: number; oomKills?: number; cpuCores?: number }

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
  /** Its user id, for its systemd user manager's cgroup; default this process's. */
  uid?: number;
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

/** A PSI file's `some` and `full` avg10 (issue #2499); undefined when it does not say both. */
export function pressureOf(t: string | undefined): { someAvg10: number; fullAvg10: number } | undefined {
  const avg = (kind: string): number | undefined => {
    const v = new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?)\\b`, 'm').exec(t ?? '')?.[1];
    return v === undefined ? undefined : Number(v);
  };
  const some = avg('some');
  const full = avg('full');
  return some !== undefined && full !== undefined ? { someAvg10: some, fullAvg10: full } : undefined;
}

/** An OOM kill count (issue #2499): `oom_kill` of one cgroup's `memory.events`, or of the kernel's. */
export interface OomCount { of: string; count: number }

/**
 * Issue #2499: when an OOM kill count was last seen to grow, over the counts read one after the other. The first count, and
 * one of another cgroup, has no count before it; a read with none keeps the last.
 */
export function oomWatch(): (seen: OomCount | undefined, at: number) => number | undefined {
  let last: OomCount | undefined;
  let killAt: number | undefined;
  return (seen, at) => {
    if (seen) {
      if (last?.of === seen.of && seen.count > last.count) killAt = at;
      last = seen;
    }
    return killAt;
  };
}

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
  const kills = oomWatch();
  let periods = new Map<string, { periods: number; throttled: number }>();
  let throttledFrac: number | undefined;
  let hostAskedAt: number | undefined;
  let hostAsking = false;
  /** Each job scope's CPU time at the read before, for its cores busy since. */
  let jobCpu = new Map<string, { at: number; usec: number }>();

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
  const ownCgroup = (): string[] => (/^0::(\/.*)$/m.exec(text(join(root, 'proc/self/cgroup')) ?? '')?.[1] ?? '/').split('/').filter(Boolean);
  /** A cgroup's memory in use, less the page cache it could drop; undefined when it says none. */
  const usedIn = (dir: string): number | undefined => {
    const current = limit(cgroup(join(dir, 'memory.current')));
    return current === undefined ? undefined : Math.max(0, current - (fields(text(cgroup(join(dir, 'memory.stat')))).get('inactive_file') ?? 0));
  };
  const cgroupMemory = (parts: string[]): { memTotalBytes: number; memAvailableBytes: number; dir: string } | undefined => {
    let tightest: { memTotalBytes: number; memAvailableBytes: number; dir: string } | undefined;
    for (let n = parts.length; n >= 0; n -= 1) {
      const dir = parts.slice(0, n).join('/');
      const max = limit(cgroup(join(dir, 'memory.max'))) ?? (n === 0 ? pod?.memBytes : undefined);
      const used = max !== undefined ? usedIn(dir) : undefined;
      if (max === undefined || used === undefined) continue;
      const available = Math.max(0, max - used);
      if (!tightest || available < tightest.memAvailableBytes) tightest = { memTotalBytes: max, memAvailableBytes: available, dir };
    }
    return tightest;
  };

  /**
   * Issue #2499: each job scope (`hopper-job-<id>.scope`, job-scope.ts) of its systemd user manager — the `user@<uid>.service`
   * its own cgroup is in, else its user's — in any slice there, with its cgroup path and its memory in use.
   */
  const managerOf = (parts: string[]): string | undefined => {
    const at = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
    const uid = d.uid ?? process.getuid?.();
    return at >= 0 ? parts.slice(0, at + 1).join('/') : uid !== undefined ? `user.slice/user-${uid}.slice/user@${uid}.service` : undefined;
  };
  const jobScopes = (parts: string[]): { id: string; dir: string; bytes: number }[] => {
    const manager = managerOf(parts);
    if (manager === undefined) return [];
    const list = (dir: string): string[] => { try { return readdirSync(cgroup(dir)); } catch { return []; } };
    return list(manager).filter((s) => s.endsWith('.slice')).flatMap((slice) => list(join(manager, slice)).flatMap((name) => {
      const id = /^hopper-job-([A-Za-z0-9_-]+)\.scope$/.exec(name)?.[1];
      const dir = join(manager, slice, name);
      const bytes = id !== undefined ? usedIn(dir) : undefined;
      return id !== undefined && bytes !== undefined ? [{ id, dir, bytes }] : [];
    }));
  };

  /**
   * Issue #2499: the OOM kill count of the limited cgroup (its subtree), else the kernel's. A count that grew since the read
   * before is a kill now; the first read, or one of another cgroup, has no count before it.
   */
  const oomKillAt = (limitedDir: string | undefined, at: number): Pick<ResourceReading, 'memOomKillAt'> => {
    const of = limitedDir !== undefined ? cgroup(join(limitedDir, 'memory.events')) : join(root, 'proc/vmstat');
    const count = fields(text(of)).get('oom_kill');
    const killAt = kills(count !== undefined ? { of, count } : undefined, at);
    return killAt !== undefined ? { memOomKillAt: new Date(killAt).toISOString() } : {};
  };

  /**
   * Issue #2499: of each cgroup on its path with a CPU quota (cpu.max), the share of its periods throttled since the read
   * before (cpu.stat nr_throttled of nr_periods); the most of them. None with no quota, or no count before.
   */
  const throttle = (): number | undefined => {
    const now = new Map<string, { periods: number; throttled: number }>();
    let most: number | undefined;
    const parts = ownCgroup();
    for (let n = parts.length; n >= 0; n -= 1) {
      const dir = parts.slice(0, n).join('/');
      if (limit(cgroup(join(dir, 'cpu.max'))) === undefined) continue;
      const stat = fields(text(cgroup(join(dir, 'cpu.stat'))));
      const p = stat.get('nr_periods');
      const t = stat.get('nr_throttled');
      if (p === undefined || t === undefined) continue;
      now.set(dir, { periods: p, throttled: t });
      const before = periods.get(dir);
      if (before && p > before.periods && t >= before.throttled) most = Math.max(most ?? 0, clamp((t - before.throttled) / (p - before.periods)));
    }
    periods = now;
    return most;
  };

  /** What each scope used so far (issue #2498); a scope with nothing read is left out. */
  const jobUseOf = (scopes: readonly { id: string; dir: string }[], at: number): Pick<ResourceReading, 'jobUse'> => {
    const next = new Map<string, { at: number; usec: number }>();
    const use = Object.fromEntries(scopes.flatMap(({ id, dir }) => {
      const peak = limit(cgroup(join(dir, 'memory.peak')));
      const usec = fields(text(cgroup(join(dir, 'cpu.stat')))).get('usage_usec');
      const oom = fields(text(cgroup(join(dir, 'memory.events')))).get('oom_kill');
      const before = jobCpu.get(id);
      let cores: number | undefined;
      if (usec !== undefined && before && at - before.at < MIN_CPU_INTERVAL_MS) next.set(id, before);
      else if (usec !== undefined) {
        next.set(id, { at, usec });
        if (before && usec >= before.usec) cores = (usec - before.usec) / 1000 / (at - before.at);
      }
      const u: JobUseNow = { ...(peak !== undefined ? { memoryPeakBytes: peak } : {}), ...(usec !== undefined ? { cpuSeconds: usec / 1e6 } : {}), ...(oom !== undefined ? { oomKills: oom } : {}), ...(cores !== undefined ? { cpuCores: cores } : {}) };
      return Object.keys(u).length ? [[id, u] as const] : [];
    }));
    jobCpu = next;
    return Object.keys(use).length ? { jobUse: use } : {};
  };

  type Memory = Pick<ResourceReading, 'memTotalBytes' | 'memAvailableBytes' | 'swapTotalBytes' | 'swapUsedBytes' | 'container' | 'vmHeldBytes' | 'jobMemoryBytes' | 'jobUse' | 'kernelMemTotalBytes' | 'kernelMemAvailableBytes' | 'memPressure' | 'memOomKillAt' | 'jobMemoryLimit'>;
  const memory = (at: number): Memory => {
    const parts = platform === 'linux' ? ownCgroup() : [];
    const scopes = platform === 'linux' ? jobScopes(parts) : [];
    const use = jobUseOf(scopes, at);
    const jobs = scopes.length ? { jobMemoryBytes: Object.fromEntries(scopes.map((s) => [s.id, s.bytes])), ...use } : {};
    const limited = platform === 'linux' ? cgroupMemory(parts) : undefined;
    // Issue #2622: what holds its jobs' memory — each job's scope where its user manager runs, else its own cgroup's limit.
    const manager = platform === 'linux' ? managerOf(parts) : undefined;
    const held = platform !== 'linux' ? {} : { jobMemoryLimit: manager !== undefined && existsSync(cgroup(manager)) ? 'scope' as const : limited ? 'machine' as const : 'none' as const };
    const info = platform === 'linux' ? fields(text(join(root, 'proc/meminfo'))) : new Map<string, number>();
    const kib = (k: string) => (info.has(k) ? info.get(k)! * 1024 : undefined);
    const total = kib('MemTotal');
    const available = kib('MemAvailable');
    // Issue #2499: the limited cgroup's memory pressure, else the kernel's.
    const psi = platform === 'linux' ? pressureOf((limited ? text(cgroup(join(limited.dir, 'memory.pressure'))) : undefined) ?? text(join(root, 'proc/pressure/memory'))) : undefined;
    const pressure = { ...(psi ? { memPressure: psi } : {}), ...(platform === 'linux' ? oomKillAt(limited?.dir, at) : {}) };
    if (limited) {
      // A scope outside the limited cgroup is not in its use, but takes the same machine's memory.
      const outside = scopes.filter((s) => limited.dir !== '' && s.dir !== limited.dir && !s.dir.startsWith(`${limited.dir}/`)).reduce((n, s) => n + s.bytes, 0);
      const kernel = total !== undefined && available !== undefined && available <= total ? { kernelMemTotalBytes: total, kernelMemAvailableBytes: available } : {};
      return { memTotalBytes: limited.memTotalBytes, memAvailableBytes: Math.max(0, limited.memAvailableBytes - outside), container: true, ...kernel, ...jobs, ...pressure, ...held };
    }
    const swapTotal = kib('SwapTotal');
    const swapFree = kib('SwapFree');
    const free = kib('MemFree');
    return {
      memTotalBytes: total ?? (d.totalmem ?? totalmem)(),
      memAvailableBytes: available ?? (d.freemem ?? freemem)(),
      ...(wsl && total !== undefined && free !== undefined ? { vmHeldBytes: Math.max(0, total - free) } : {}),
      ...(swapTotal !== undefined && swapFree !== undefined ? { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) } : {}),
      ...jobs, ...pressure, ...held,
    };
  };

  return () => {
    const at = now();
    const q = quota();
    if (!last || at - last.at >= MIN_CPU_INTERVAL_MS) {
      const t = cpuTimes(q, at);
      if (last && t.total > last.total) busyFrac = clamp((t.busy - last.busy) / (t.total - last.total));
      last = { at, ...t };
      if (platform === 'linux') throttledFrac = throttle();
    }
    const mem = memory(at);
    const bootId = platform === 'linux' ? text(join(root, 'proc/sys/kernel/random/boot_id'))?.trim() : undefined;
    const l = (d.loadavg ?? loadavg)();
    return {
      cores: q ?? (d.parallelism ?? availableParallelism)(),
      ...(busyFrac !== undefined ? { cpuBusyFrac: busyFrac } : {}),
      ...(throttledFrac !== undefined ? { cpuThrottledFrac: throttledFrac } : {}),
      ...(platform !== 'win32' && l.length === 3 ? { load: [l[0]!, l[1]!, l[2]!] as [number, number, number] } : {}),
      ...mem,
      ...(bootId ? { bootId } : {}),
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
