// A job's trust stamp on the job view (issue #655): its trust level in plain words, and whether a person may quarantine
// it, or lift its quarantine. The daemon checks the stamp; the UI only reads what it says.
import type { Job, JobStatus } from './wire.ts';

/** The statuses a job ends in (src/domain/types.ts TERMINAL_STATUSES): an ended job is not quarantined or lifted. */
const ENDED: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];

type Level = NonNullable<Job['stamp']>['level'];

const LEVEL: Record<Level, string> = {
  owner: 'owner — you wrote and nominated its item',
  trusted: 'trusted — a trusted actor wrote its item',
  approved: 'approved — a person approved it',
  screened: 'screened — nothing found, no person approved it',
  untrusted: 'untrusted — held until a person approves it',
  quarantined: 'quarantined — held, and it reaches nothing through the hopper',
};

/** The job's trust level in plain words; undefined: it has no stamp. */
export const trustText = (job: Pick<Job, 'stamp'>): string | undefined => (job.stamp ? LEVEL[job.stamp.level] : undefined);

export const isQuarantined = (job: Pick<Job, 'stamp'>): boolean => job.stamp?.level === 'quarantined';

/** Whether the job view offers Quarantine or Lift quarantine: a job that has not ended, with a stamp. */
export const quarantineOffered = (job: Pick<Job, 'status' | 'stamp'>): boolean => job.stamp !== undefined && !ENDED.includes(job.status);
