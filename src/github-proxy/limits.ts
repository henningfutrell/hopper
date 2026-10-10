// How often a job, and a machine, may have the hopper act on GitHub (issue #563): per operation, in any hour.
// Kept in memory: a restart starts every count again.
import type { Clock } from '../domain/ports.ts';
import type { ProxyOp } from './policy.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Per hour: per job, and per machine across its jobs. */
export const PROXY_LIMITS: Readonly<Record<ProxyOp, { job: number; machine: number }>> = {
  'issue.create': { job: 5, machine: 20 },
  'issue.comment': { job: 20, machine: 100 },
  'pr.create': { job: 3, machine: 20 },
  'issue.view': { job: 120, machine: 600 },
  'issue.close': { job: 3, machine: 20 },
  'pr.view': { job: 120, machine: 600 },
  'pr.ready': { job: 5, machine: 20 },
};

export interface ProxyLimiter {
  /** Counts one request of `op` for the job and the machine; else why it is over a limit, and counts nothing. */
  take(op: ProxyOp, job: string, machine: string | undefined): string | undefined;
}

export function createProxyLimiter(clock: Clock, limits = PROXY_LIMITS): ProxyLimiter {
  const seen = new Map<string, number[]>();
  const recent = (key: string, now: number): number[] => {
    const kept = (seen.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (kept.length > 0) seen.set(key, kept); else seen.delete(key);
    return kept;
  };
  return {
    take(op, job, machine) {
      const now = clock.now().getTime();
      const jobKey = `job\0${job}\0${op}`;
      const machineKey = machine === undefined ? undefined : `machine\0${machine}\0${op}`;
      if (recent(jobKey, now).length >= limits[op].job) return `this job asked for ${op} ${limits[op].job} times in the last hour, its limit`;
      if (machineKey && recent(machineKey, now).length >= limits[op].machine) return `jobs on its machine asked for ${op} ${limits[op].machine} times in the last hour, its limit`;
      seen.set(jobKey, [...recent(jobKey, now), now]);
      if (machineKey) seen.set(machineKey, [...recent(machineKey, now), now]);
      return undefined;
    },
  };
}
