// A job's processes without a systemd scope (issue #2737, design.md "The job's scope"): where the machine runs no systemd
// user manager (WSL without systemd), no scope holds a job's processes, so the meter finds them in /proc: each process
// with HOPPER_JOB_ID in its environment, and each process one of them started, by its parent, whatever it did to its
// environment. A job's memory is its processes' own memory (RssAnon and RssShmem): the page cache is not counted, as a
// scope's memory less its inactive_file does not count it. A process that leaves its session and its parent's tree and
// clears its environment escapes it, as it escapes the reap's fallback. Linux only: /proc. Imports nothing of hopper.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const text = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

interface Proc { ppid: number; jobId?: string; bytes: number }

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
  // A process's job: its own HOPPER_JOB_ID, else its nearest ancestor's. Memoized; a loop in the parents (a pid reused
  // mid-read) ends with none.
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

/**
 * A meter of the jobs' processes: each read gives each job's memory now and the most of it seen while the job's processes
 * ran (its peak, as a scope's `memory.peak`); a job with no process now drops its peak. None when no job has a process.
 */
export function jobProcessMeter(root = '/'): () => { jobMemoryBytes?: Record<string, number>; jobUse?: Record<string, { memoryPeakBytes: number }> } {
  let peaks = new Map<string, number>();
  return () => {
    const now = jobProcessMemory(root);
    peaks = new Map([...now].map(([id, bytes]) => [id, Math.max(bytes, peaks.get(id) ?? 0)]));
    if (!now.size) return {};
    return { jobMemoryBytes: Object.fromEntries(now), jobUse: Object.fromEntries([...peaks].map(([id, peak]) => [id, { memoryPeakBytes: peak }])) };
  };
}
