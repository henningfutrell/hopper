// A job's trust stamp on the job view (issue #655): its trust level in plain words, and whether a person may quarantine
// it, or lift its quarantine; why Jev's trust check lowered it, and whether a person may approve its trust (part 4). The
// daemon checks the stamp; the UI only reads what it says.
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

/** Why Jev's trust check lowers a job (src/domain/trust-check.ts), in plain words. */
const CHECK_REASON: Readonly<Record<string, string>> = {
  touches_ci: 'it changes CI, workflow files or branch rules',
  credentials: 'it asks for credentials, tokens or secrets',
  destructive: 'it deletes, overwrites or force-pushes',
  out_of_scope: 'it works outside its own repository',
  instructs_agent: 'its text gives instructions to the agent or to Jev',
  unclear: 'what it asks for is not clear',
  no_answer: 'Jev gave no answer',
  not_sure: 'Jev was not sure enough',
  skipped: 'Jev could not be asked',
};

/** The last reason Jev's trust check gave the stamp, its id; undefined: no check lowered it. */
const checkReason = (job: Pick<Job, 'stamp'>): string | undefined =>
  job.stamp?.reasons.filter((r) => r.startsWith('jev:')).at(-1)?.slice('jev:'.length);

/** Below this a job is held for a person (src/domain/trust-stamp.ts DISPATCH_MIN): `untrusted`, `screened`. */
const BELOW_APPROVED: readonly Level[] = ['untrusted', 'screened'];

/** Why Jev's trust check holds the job, in plain words; undefined: it holds none. */
export function trustCheckText(job: Pick<Job, 'stamp'>): string | undefined {
  const id = checkReason(job);
  if (!id || !job.stamp || !BELOW_APPROVED.includes(job.stamp.level)) return undefined;
  return `Jev's trust check lowered it: ${CHECK_REASON[id] ?? id}`;
}

/** Whether the job view offers Approve trust: a job that has not ended that Jev's trust check lowered below approved. */
export const trustApprovalOffered = (job: Pick<Job, 'status' | 'stamp'>): boolean => quarantineOffered(job) && trustCheckText(job) !== undefined;
