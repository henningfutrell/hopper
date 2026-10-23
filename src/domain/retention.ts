// The retention per job status (issue #2494, design.md "The sweep"): how long an ended job's scratch dir and job worktrees
// stay on its machine. A machine's `retainHours` for the status the job ended in counts from the job's end (`finishedAt`;
// with none, the dir's age); with none set for the status, the dir goes once it is `scratchMaxAgeHours` old, as before.
// Work not pushed is kept whatever this says: that is the reap's rule.
import type { EndStatus, SweepSettings } from './machines.ts';
import type { Job, JobStatus } from './types.ts';

/** How old an ended job's scratch dir gets before the sweep reaps it, when its machine names no age (issue #410). */
export const SCRATCH_MAX_AGE_HOURS = 24;

const HOUR_MS = 3600_000;
const END_STATUSES: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'] satisfies EndStatus[];

/** The hours the machine keeps a job's work after it ended in `status`; undefined: none set for it. */
const retainHoursOf = (s: SweepSettings | undefined, status: JobStatus): number | undefined =>
  (END_STATUSES.includes(status) ? s?.retainHours?.[status as EndStatus] : undefined);

/** Pure: whether an ended job's work (its dir `ageMs` old) may be reaped at `nowMs`. */
export function retentionOver(s: SweepSettings | undefined, job: Job, ageMs: number, nowMs: number): boolean {
  const hours = retainHoursOf(s, job.status);
  if (hours === undefined) return ageMs >= (s?.scratchMaxAgeHours ?? SCRATCH_MAX_AGE_HOURS) * HOUR_MS;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  return (Number.isNaN(end) ? ageMs : nowMs - end) >= hours * HOUR_MS;
}

/** Whether the reap at a job's end keeps its scratch dir: a retention above 0 set for the status it ended in. */
export const retainsAtEnd = (s: SweepSettings | undefined, status: JobStatus): boolean => (retainHoursOf(s, status) ?? 0) > 0;
