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

/** What intake did with one item, and the source that lists it (search, issue #945); none lists it: undefined. */
export function intakeOutcomeOf(statuses: readonly SourceStatus[], key: string): { source: string; outcome: IntakeOutcome } | undefined {
  for (const st of statuses) {
    const outcome = (Array.isArray(st.detail?.intake) ? st.detail.intake as IntakeOutcome[] : []).find((x) => x.key === key);
    if (outcome) return { source: st.name, outcome };
  }
  return undefined;
}

/** A refusal because the item is taken names its job's status (issue #1045). */
export function withTakenStatus(failed: Record<string, string>, jobOf: (key: string) => Job | undefined): void {
  for (const [key, why] of Object.entries(failed)) {
    const job = why.startsWith('already ') ? jobOf(key) : undefined;
    if (job) failed[key] = `${why}: its job is ${job.status}`;
  }
}
