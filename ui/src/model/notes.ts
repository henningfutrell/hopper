// Notes to a job (issue #997): whether the job view offers Add note, and each note's state in plain words.
import type { Job, JobNote, JobStatus } from './wire.ts';

/** The statuses the daemon takes a note in (src/domain/job-notes.ts): every one a job may still run from. */
const TAKES_NOTES: readonly JobStatus[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'waiting_on', 'parked', 'failed'];

/** Whether the job takes a note now. A failed job not the newest of its item is refused by the daemon, which says why. */
export const takesNotes = (job: Pick<Job, 'status'>): boolean => TAKES_NOTES.includes(job.status);

const VIA: Record<JobNote['via'], string> = { ui: 'in the UI', api: 'over the API', cli: 'from the operator CLI' };

/** Who sent the note, and how. */
export const noteFrom = (n: Pick<JobNote, 'by' | 'via'>): string => `${n.by}, ${VIA[n.via]}`;

const DELIVERED: Record<NonNullable<JobNote['delivery']>, string> = {
  start: 'delivered in its task as it started',
  turn: 'delivered at a turn boundary',
  resume: 'delivered with the answer it resumed with',
};

/** Where the note is, in plain words. */
export function noteStateText(n: JobNote): string {
  if (n.state === 'delivered') return n.delivery ? DELIVERED[n.delivery] : 'delivered';
  if (n.state === 'carried') return n.carriedTo ? `carried to job ${n.carriedTo.slice(0, 8)}` : 'carried to a new job';
  return 'queued: it goes in at the next turn boundary, or when the job goes on';
}
