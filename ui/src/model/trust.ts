// A job's trust stamp on the job view (issue #655): its trust level in plain words, and whether a person may quarantine
// it, or lift its quarantine; why Jev's trust check lowered it, and whether a person may approve its trust (part 4). The
// daemon checks the stamp; the UI only reads what it says. A person's deny at gate 2 lowers a job too (part 5), and an
// edit of a started job's item (part 7).
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

/** A person's deny at gate 2 (src/domain/trust-stamp.ts DENY_REASON): a declined sandbox request. */
const DENY_REASON = 'deny:sandbox';
/** Jev's deny at gate 2 (src/domain/trust-stamp.ts JEV_DENY_REASON, part 13): its sandbox-request check denied a request. */
const JEV_DENY_REASON = 'deny:jev';
/** An edit of a started job's item (src/domain/trust-stamp.ts EDIT_REASON). */
const EDIT_REASON = 'edit:text';

/** The last reason that lowered the stamp: a deny's, an edit's, or Jev's trust check's id; undefined: none lowered it. */
const loweredBy = (job: Pick<Job, 'stamp'>): string | undefined =>
  job.stamp?.reasons.filter((r) => r === DENY_REASON || r === JEV_DENY_REASON || r === EDIT_REASON || r.startsWith('jev:')).at(-1);

/** Below this a job is held for a person (src/domain/trust-stamp.ts DISPATCH_MIN): `untrusted`, `screened`. */
const BELOW_APPROVED: readonly Level[] = ['untrusted', 'screened'];

/** Why Jev's trust check, a person's deny or an edit holds the job, in plain words; undefined: none holds it. */
export function trustCheckText(job: Pick<Job, 'stamp'>): string | undefined {
  const r = loweredBy(job);
  if (!r || !job.stamp || !BELOW_APPROVED.includes(job.stamp.level)) return undefined;
  if (r === DENY_REASON) return 'A person declined its sandbox request';
  if (r === JEV_DENY_REASON) return 'Jev denied its sandbox request';
  if (r === EDIT_REASON) return 'Its item was edited after it started';
  const id = r.slice('jev:'.length);
  return `Jev's trust check lowered it: ${CHECK_REASON[id] ?? id}`;
}

/** Whether the job view offers Approve trust: a job that has not ended that Jev's trust check, a deny or an edit lowered below approved. */
export const trustApprovalOffered = (job: Pick<Job, 'status' | 'stamp'>): boolean => quarantineOffered(job) && trustCheckText(job) !== undefined;
