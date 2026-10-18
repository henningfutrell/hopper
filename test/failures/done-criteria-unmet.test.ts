// Done criteria unmet (issue #1924): a job that ended done while a done criterion of its conditional skills is not met — a
// plan check not passed, a terraform plan that destroys or replaces a resource — is sent back to rework, not trusted. The
// cause wins over Not complete; the assessor sends it back while under the retry limit, then it is a person's with the reason;
// its Continue tells the job what the done check found.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type FailureRecord, type Job } from '../../src/domain/types.ts';
import type { RerunResult } from '../../src/domain/ports.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { DONE_CRITERIA_UNMET, matchCause } from '../../src/failures/causes.ts';
import { causeInputOf } from '../../src/failures/chain.ts';
import { signatureOf } from '../../src/failures/signature.ts';
import { createUnfinished } from '../../src/failures/unfinished.ts';

const UNMET = 'not complete: the issue https://github.com/o/infra/issues/1425 is open, and PR #103: done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource (terraform plan (control-plane)); at most 0 may be';

function input(error: string, over: Partial<AssessInput> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, maxAttempts: 3 }, ...over,
  };
}

describe('the cause Done criteria unmet', () => {
  it('matches a miss that names a skill\'s done criteria on the pull request, ahead of Not complete', () => {
    expect(input(UNMET).cause).toMatchObject({ id: DONE_CRITERIA_UNMET, name: 'Done criteria unmet', decision: 'continue' });
    expect(input(UNMET.replace('not met', 'not known')).cause?.id).toBe(DONE_CRITERIA_UNMET);
    expect(input('not complete: the issue https://github.com/o/infra/issues/1425 is open, and no pull request in o/infra closes or references it').cause?.id).toBe('not-complete');
  });

  it('goes on to rework, not a person, while under the retry limit; then a person, with the reason', () => {
    expect(assess(input(UNMET, { criteriaFixes: 0 }))).toMatchObject({ cls: 'transient', decision: 'continue', auto: true });
    expect(assess(input(UNMET, { criteriaFixes: 1 })).summary).toMatch(/^Continues: it reworks its pull request to meet the done criteria\./);
    const spent = assess(input(UNMET, { criteriaFixes: 3 }));
    expect(spent).toMatchObject({ decision: 'person' });
    expect(spent.reasons.join(' ')).toMatch(/retry limit reached: sent back 3 times for its done criteria/);
  });

  it('counts the send-backs of its chain', () => {
    const job = { id: 'j2', rerunOf: 'j1' } as Job;
    const store = {
      jobs: { get: (id: string) => (id === 'j1' ? { id: 'j1' } as Job : undefined) },
      failures: { list: ({ jobId }: { jobId: string }) => [{ jobId, causeId: DONE_CRITERIA_UNMET, outcome: 'retried' }] as FailureRecord[] },
    };
    expect(causeInputOf(store as never, job, DONE_CRITERIA_UNMET)).toEqual({ criteriaFixes: 2 });
  });
});

describe('its Continue', () => {
  const job = { id: 'j1', workTree: '/work/j1' } as unknown as Job;
  const record = { id: 'f1', jobId: 'j1', causeId: DONE_CRITERIA_UNMET, pending: 'continue', evidence: { error: UNMET } } as FailureRecord;

  function harness(resumable = true) {
    const continued: string[] = [];
    const reruns: string[] = [];
    const ok = (): RerunResult => ({ ok: true, job });
    const u = createUnfinished({
      store: { jobs: { get: (id: string) => (id === job.id ? job : undefined) } } as never,
      unfinishedPullRequest: async () => undefined, resumable: () => resumable,
      continueJob: async (_id, brief) => { continued.push(brief); return ok(); },
      rerun: async (_id, _by, brief) => { reruns.push(brief ?? ''); return ok(); },
    });
    return { u, continued, reruns };
  }

  it('its own session, told what the done check found and to fix it on the same branch', async () => {
    const h = harness();
    expect(await h.u.continueOf(record)).toMatchObject({ ok: true });
    const brief = h.continued[0]!;
    expect(brief).toMatch(/same session and work tree: you ended the job as done, but the done criteria of its skills are not met/);
    expect(brief).toContain('What the hopper found: the issue https://github.com/o/infra/issues/1425 is open, and PR #103: done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource');
    expect(brief).toContain('Do not open a new pull request.');
    expect(brief).toMatch(/If you cannot meet one, end the job as failed and say why\.$/);
  });

  it('no session to resume: a new job of its item, told the same', async () => {
    const h = harness(false);
    await h.u.continueOf(record);
    expect(h.continued).toEqual([]);
    expect(h.reruns[0]).toMatch(/^The hopper runs this issue again: the earlier job ended as done, but the done criteria of its skills were not met\./);
  });
});
