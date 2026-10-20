// What Continue does on a hand-off (issues #551, #2233): it resumes the job's own agent session when that session can go
// on, else it runs a new job. A job that failed with no way to the hopper never resumes: its session keeps telling it
// the hopper is out of reach, so Continue runs a new job, placed afresh. Pure, with plain stores.
import { describe, expect, it } from 'vitest';
import type { FailureRecord, Handoff, Job } from '../../src/domain/types.ts';
import { NO_WAY_TO_HOPPER } from '../../src/failures/causes.ts';
import { handoffView } from '../../src/failures/view.ts';

const JOB = { id: 'job-1', agentSession: 'session-1', status: 'failed' } as Job;
const ERROR = 'this machine cannot reach the hopper: HOPPER_URL and the hopper helper variables are missing';
const handoff = (o: Partial<Handoff> = {}): Handoff =>
  ({ id: 'h-1', jobId: JOB.id, status: 'closed', reason: 'person', openedAt: '2026-10-20T15:00:00.000Z', summary: 'Needs a person.', reasons: [], error: 'the tests do not pass', ...o });
const storeWith = (record?: Partial<FailureRecord>) => ({
  failures: { get: (id: string) => (record && id === 'r-1' ? { id: 'r-1', jobId: JOB.id, ...record } as FailureRecord : undefined) },
  jobs: { get: (id: string) => (id === JOB.id ? JOB : undefined) },
}) as unknown as Parameters<typeof handoffView>[0];
const resumable = () => true;
const takesBack = () => ({ ok: true as const });

describe('handoffView: Continue (issue #2233)', () => {
  it('resumes the job\'s own session for any other cause', () => {
    expect(handoffView(storeWith({ causeId: 'not-complete' }), handoff({ recordId: 'r-1' }), resumable, takesBack).continueResumes).toBe(true);
  });

  it('runs a new job when its failure record says it had no way to the hopper', () => {
    const v = handoffView(storeWith({ causeId: NO_WAY_TO_HOPPER }), handoff({ recordId: 'r-1', error: ERROR }), resumable, takesBack);
    expect(v.continueResumes).toBe(false);
    expect(v.card.why).toMatch(/A new job starts/);
  });

  it('runs a new job when a hand-off with no record failed so', () => {
    expect(handoffView(storeWith(), handoff({ error: ERROR }), resumable, takesBack).continueResumes).toBe(false);
  });
});
