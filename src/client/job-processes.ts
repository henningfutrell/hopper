// A job's processes without a systemd scope (issue #2737, design.md "The job's scope"): where the machine runs no systemd
// user manager (WSL without systemd), no scope holds a job's processes, so the meter finds them in /proc: each process
// with HOPPER_JOB_ID in its environment, and each process one of them started, by its parent, whatever it did to its
// environment. A job's memory is its processes' own memory (RssAnon and RssShmem): the page cache is not counted, as a
// scope's memory less its inactive_file does not count it. A process that leaves its session and its parent's tree and
// clears its environment escapes it, as it escapes the reap's fallback. On macOS, with no /proc, `ps` says the same: the
// environment it prints after each command (its own user's processes only, as the jobs are), and each process's resident
// memory, which there holds shared pages too. An ssh target prints the same in its probe (src/machines/resources.ts).
// Imports nothing of hopper.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const text = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

interface Proc { ppid: number; jobId?: string | undefined; bytes: number }

/** One process: its parent (after the last `)` of stat, as the name may hold one), its job id and its own memory; undefined when gone or unreadable. */
function procOf(dir: string): Proc | undefined {
  const stat = text(join(dir, 'stat'));
  const ppid = stat !== undefined ? Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]) : NaN;
  const status = text(join(dir, 'status'));
  if (!Number.isInteger(ppid) || status === undefined) return undefined;
  let kib = 0;
  for (const m of status.matchAll(/^(?:RssAnon|RssShmem):\s+(\d+)\s*kB/gm)) kib += Number(m[1]);
  const jobId = /(?:^|\0)HOPPER_JOB_ID=([A-Za-z0-9_-]+)(?:\0|$)/.exec(text(join(dir, 'environ')) ?? '')?.[1];
  return { ppid, bytes: kib * 1024, ...(jobId !== undefined ? { jobId } : {}) };
}

/** Each job's processes' memory in bytes, by job id, as /proc under `root` says it now. */
export function jobProcessMemory(root = '/'): Map<string, number> {
  const procDir = join(root, 'proc');
  let pids: string[];
  try {
    pids = readdirSync(procDir).filter((p) => /^\d+$/.test(p));
  } catch {
    return new Map();
  }
  const procs = new Map<number, Proc>();
  for (const pid of pids) {
    const p = procOf(join(procDir, pid));
    if (p) procs.set(Number(pid), p);
  }
  return jobsOf(procs);
}

/** Each job's processes' memory in bytes, by job id, as `ps -axeww -o pid=,ppid=,rss=,command=` printed it (rss in KiB). */
export function jobPsMemory(stdout: string): Map<string, number> {
  const procs = new Map<number, Proc>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line);
    if (!m) continue;
    const jobId = /(?:^|\s)HOPPER_JOB_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(m[4] ?? '')?.[1];
    procs.set(Number(m[1]), { ppid: Number(m[2]), bytes: Number(m[3]) * 1024, ...(jobId !== undefined ? { jobId } : {}) });
  }
  return jobsOf(procs);
}

/**
 * Each job's processes' memory in bytes, by job id, from an ssh target's probe lines: `jp <pid> <ppid> <KiB> [<job id>]`
 * for each process, and `je <pid> <job id>` for each that has HOPPER_JOB_ID in its environment.
 */
export function jobProbeMemory(lines: readonly string[]): Map<string, number> {
  const procs = new Map<number, Proc>();
  const ids = new Map<number, string>();
  for (const line of lines) {
    const p = /^jp (\d+) (\d+) (\d+)(?: ([A-Za-z0-9_-]{1,64}))?\s*$/.exec(line);
    if (p) procs.set(Number(p[1]), { ppid: Number(p[2]), bytes: Number(p[3]) * 1024, ...(p[4] !== undefined ? { jobId: p[4] } : {}) });
    const e = /^je (\d+) ([A-Za-z0-9_-]{1,64})\s*$/.exec(line);
    if (e) ids.set(Number(e[1]), e[2]!);
  }
  for (const [pid, jobId] of ids) { const p = procs.get(pid); if (p) p.jobId = jobId; }
  return jobsOf(procs);
}

/** Each job's memory: a process's job is its own HOPPER_JOB_ID, else its nearest ancestor's. */
function jobsOf(procs: Map<number, Proc>): Map<string, number> {
  // Memoized; a loop in the parents (a pid reused mid-read) ends with none.
  const jobOf = new Map<number, string | undefined>();
  const resolve = (pid: number, seen: Set<number>): string | undefined => {
    if (jobOf.has(pid)) return jobOf.get(pid);
    const p = procs.get(pid);
    if (!p || seen.has(pid)) return undefined;
    seen.add(pid);
    const id = p.jobId ?? resolve(p.ppid, seen);
    jobOf.set(pid, id);
    return id;
  };
  const out = new Map<string, number>();
  for (const [pid, p] of procs) {
    const id = resolve(pid, new Set());
    if (id !== undefined) out.set(id, (out.get(id) ?? 0) + p.bytes);
  }
  return out;
}

/** macOS: every process, with the environment ps prints after its command. */
const psAll = (): Promise<string> => new Promise((resolve, reject) => {
  execFile('ps', ['-axeww', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** How often, at most, ps is run again on macOS. */
const PS_INTERVAL_MS = 10_000;

export interface JobProcessMeterDeps {
  platform?: string;
  now?: () => number;
  /** macOS: what `ps -axeww -o pid=,ppid=,rss=,command=` prints; default runs it. */
  ps?: () => Promise<string>;
}

/**
 * A meter of the jobs' processes: each read gives each job's memory now and the most of it seen while the job's processes
 * ran (its peak, as a scope's `memory.peak`); a job with no process now drops its peak. None when no job has a process.
 */
export function jobProcessMeter(root = '/', d: JobProcessMeterDeps = {}): () => { jobMemoryBytes?: Record<string, number>; jobUse?: Record<string, { memoryPeakBytes: number }> } {
  let peaks = new Map<string, number>();
  // macOS: ps runs in the background, one at a time and at most each PS_INTERVAL_MS; a read takes what it said last.
  let listed = new Map<string, number>(); let askedAt: number | undefined; let asking = false;
  const clock = d.now ?? Date.now; const ps = d.ps ?? psAll;
  const fromPs = (): Map<string, number> => {
    const at = clock();
    if (!asking && (askedAt === undefined || at - askedAt >= PS_INTERVAL_MS)) {
      asking = true;
      askedAt = at;
      ps().then((out) => { listed = jobPsMemory(out); }, () => { listed = new Map(); }).finally(() => { asking = false; });
    }
    return listed;
  };
  return () => {
    const now = (d.platform ?? process.platform) === 'darwin' ? fromPs() : jobProcessMemory(root);
    peaks = new Map([...now].map(([id, bytes]) => [id, Math.max(bytes, peaks.get(id) ?? 0)]));
    if (!now.size) return {};
    return { jobMemoryBytes: Object.fromEntries(now), jobUse: Object.fromEntries([...peaks].map(([id, peak]) => [id, { memoryPeakBytes: peak }])) };
  };
}
