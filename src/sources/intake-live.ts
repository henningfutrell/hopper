// A source status as it is now (issue #798): its intake is the list as of the last sync, but each taken item's job and
// that job's status are read when the status is, so an ended job's issue reads as taken no more. Apart from sync.ts for
// its size.
import type { IntakeOutcome } from '../domain/intake.ts';
import type { Job, SourceStatus } from '../domain/types.ts';

export function liveIntake(st: SourceStatus, jobOf: (key: string) => Job | undefined): SourceStatus {
  const intake = st.detail?.intake;
  if (!Array.isArray(intake)) return { ...st };
  const withJob = (x: IntakeOutcome): IntakeOutcome => { const job = jobOf(x.key); return job ? { ...x, jobId: job.id, jobStatus: job.status } : x; };
  return { ...st, detail: { ...st.detail, intake: (intake as IntakeOutcome[]).map((x) => (x.reason === undefined ? withJob(x) : x)) } };
}
