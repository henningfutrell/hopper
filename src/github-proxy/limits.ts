// How often a job, and a machine, may have the hopper act on GitHub (issue #563): per operation, in any hour — a bug
// report (issue #694) in any day. Kept in memory: a restart starts every count again.
import type { Clock } from '../domain/ports.ts';
import type { ProxyOp, REPORT_OP } from './policy.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What is counted: each proxy operation, and a job's bug report. */
export type LimitedOp = ProxyOp | typeof REPORT_OP;

/** Per window (an hour unless it says a day): per job, and per machine across its jobs. */
export const PROXY_LIMITS: Readonly<Record<LimitedOp, { job: number; machine: number; day?: true }>> = {
  'issue.create': { job: 5, machine: 20 },
  'issue.comment': { job: 20, machine: 100 },
  'pr.create': { job: 3, machine: 20 },
  'issue.view': { job: 120, machine: 600 },
  'issue.comments': { job: 120, machine: 600 },
  'issue.close': { job: 3, machine: 20 },
  'pr.view': { job: 120, machine: 600 },
  'pr.diff': { job: 120, machine: 600 },
  'pr.commits': { job: 120, machine: 600 },
  'pr.checks': { job: 120, machine: 600 },
  'pr.reviews': { job: 120, machine: 600 },
  // An answer from the hopper's records is not counted (issue #1072): it costs GitHub nothing.
  'pr.status': { job: 120, machine: 600 },
  'pr.ready': { job: 5, machine: 20 },
  'repo.view': { job: 120, machine: 600 },
  'repo.fork': { job: 3, machine: 20 },
  'check.log': { job: 30, machine: 150 },
  'report.bug': { job: 3, machine: 10, day: true },
};

export interface ProxyLimiter {
  /** Counts one request of `op` for the job and the machine; else why it is over a limit, and counts nothing. */
  take(op: LimitedOp, job: string, machine: string | undefined): string | undefined;
}

export function createProxyLimiter(clock: Clock, limits = PROXY_LIMITS, seen = new Map<string, { windowMs: number; times: number[] }>()): ProxyLimiter {
  const recent = (key: string): number[] => seen.get(key)?.times ?? [];
  const count = (key: string, windowMs: number, now: number) => seen.set(key, { windowMs, times: [...recent(key), now] });
  return {
    take(op, job, machine) {
      const now = clock.now().getTime();
      // Drop what left its window, every key's (as polls.ts): an ended job's counts do not stay.
      for (const [k, kept] of seen) {
        const times = kept.times.filter((t) => now - t < kept.windowMs);
        if (times.length > 0) seen.set(k, { windowMs: kept.windowMs, times }); else seen.delete(k);
      }
      const [windowMs, window] = limits[op].day ? [DAY_MS, 'day'] : [HOUR_MS, 'hour'];
      const jobKey = `job\0${job}\0${op}`;
      const machineKey = machine === undefined ? undefined : `machine\0${machine}\0${op}`;
      if (recent(jobKey).length >= limits[op].job) return `this job asked for ${op} ${limits[op].job} times in the last ${window}, its limit`;
      if (machineKey && recent(machineKey).length >= limits[op].machine) return `jobs on its machine asked for ${op} ${limits[op].machine} times in the last ${window}, its limit`;
      count(jobKey, windowMs, now);
      if (machineKey) count(machineKey, windowMs, now);
      return undefined;
    },
  };
}
