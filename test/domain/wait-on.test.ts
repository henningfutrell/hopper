// Issue #1245: a job's own wait always names what it waits on, typed — a pull request, a job, an item, a person's
// question, an approval, a grant, its own command, or an outside event. A job never enters `waiting_on` without it. Pure.
import { describe, expect, it } from 'vitest';
import { settledBy, waitEntryProblem, waitOnLabel, waitOnOf, waitsFor, type WaitOn } from '../../src/domain/wait-on.ts';
import type { Job } from '../../src/domain/types.ts';

const since = '2026-10-15T00:00:00.000Z';

describe('what a wait waits on (issue #1245)', () => {
  it.each<[string, WaitOn]>([
    ['pr 12 merge', { kind: 'pull_request', number: 12, about: 'merge' }],
    ['PR #12 checks', { kind: 'pull_request', number: 12, about: 'checks' }],
    ['pull request 7 review', { kind: 'pull_request', number: 7, about: 'review' }],
    ['o/r#9 merge', { kind: 'pull_request', repo: 'o/r', number: 9, about: 'merge' }],
    ['job 1a2b3c', { kind: 'job', jobId: '1a2b3c' }],
    ['issue #45', { kind: 'item', number: 45 }],
    ['question q-7', { kind: 'question', questionId: 'q-7' }],
    ['sandbox approval', { kind: 'approval', of: 'sandbox' }],
    ['template approval', { kind: 'approval', of: 'template' }],
    ['vault grant', { kind: 'grant' }],
    ['own command', { kind: 'own_command' }],
    ['outside: the release of v2', { kind: 'outside', what: 'the release of v2' }],
  ])('on: "%s"', (on, want) => {
    expect(waitOnOf({ for: 'something', on })).toEqual(want);
  });

  it('with no on: line, it is read from what the job wrote', () => {
    expect(waitOnOf({ for: 'PR #31 to merge' })).toEqual({ kind: 'pull_request', number: 31, about: 'merge' });
    expect(waitOnOf({ for: 'the checks of pull request 31' })).toEqual({ kind: 'pull_request', number: 31, about: 'checks' });
    expect(waitOnOf({ for: 'the tests', until: 'background command b7x2 ends' })).toEqual({ kind: 'own_command' });
    expect(waitOnOf({ for: 'the sandbox template to be approved' })).toEqual({ kind: 'approval', of: 'template' });
    expect(waitOnOf({ for: 'a vault grant for the token' })).toEqual({ kind: 'grant' });
    expect(waitOnOf({ for: 'write access to the repository' })).toEqual({ kind: 'outside', what: 'write access to the repository' });
  });

  it('an on: line it cannot read is an outside event with what the job wrote', () => {
    expect(waitOnOf({ for: 'a release', on: 'the moon' })).toEqual({ kind: 'outside', what: 'the moon' });
  });

  it('is said in a few words', () => {
    expect(waitOnLabel({ kind: 'pull_request', number: 12, about: 'merge' })).toBe('PR #12 to merge');
    expect(waitOnLabel({ kind: 'pull_request', repo: 'o/r', number: 12, about: 'checks' })).toBe('o/r#12 checks to end');
    expect(waitOnLabel({ kind: 'outside', what: 'a release' })).toBe('outside: a release');
  });
});

describe('a job enters waiting_on only with what it waits on (issue #1245)', () => {
  const job = (over: Partial<Job>): Job => ({ id: 'j1', status: 'running', ...over }) as Job;
  it('without a dependency it is refused', () => {
    expect(waitEntryProblem(job({}), job({ status: 'waiting_on' }))).toMatch(/waits on nothing/);
    expect(waitEntryProblem(job({}), job({ status: 'waiting_on', wait: { for: 'x', since } }))).toMatch(/waits on nothing/);
  });
  it('with one, or staying on a wait it already has, it is not', () => {
    expect(waitEntryProblem(job({}), job({ status: 'waiting_on', wait: { for: 'x', since, on: { kind: 'grant' } } }))).toBeUndefined();
    const legacy = job({ status: 'waiting_on', wait: { for: 'x', since } });
    expect(waitEntryProblem(legacy, { ...legacy, wait: { ...legacy.wait!, nudgedAt: since } })).toBeUndefined();
  });
});

describe('the jobs a merged pull request wakes (issue #1245)', () => {
  const waiting = (id: string, on: WaitOn, repo = 'o/r'): Job =>
    ({ id, status: 'waiting_on', wait: { for: 'x', since, on }, source: { repo } }) as unknown as Job;
  it('those waiting on its merge, or on it at all, in its repository', () => {
    const jobs = [
      waiting('a', { kind: 'pull_request', number: 12, about: 'merge' }),
      waiting('b', { kind: 'pull_request', number: 12, about: 'review' }),
      waiting('c', { kind: 'pull_request', number: 13, about: 'merge' }),
      waiting('d', { kind: 'pull_request', number: 12, about: 'merge' }, 'x/y'),
      waiting('e', { kind: 'pull_request', repo: 'o/r', number: 12, about: 'merge' }, 'x/y'),
      waiting('f', { kind: 'outside', what: 'PR 12' }),
    ];
    const merged = settledBy({ type: 'job.pull_request_merged', data: { pullRequest: 'https://github.com/o/r/pull/12', part: false } })!;
    expect(merged.note).toBe('https://github.com/o/r/pull/12 was merged');
    expect(jobs.filter((j) => waitsFor(j, merged)).map((j) => j.id)).toEqual(['a', 'b', 'e']);
  });
});

describe('the jobs each dependency\'s event wakes (issue #1245, part 2)', () => {
  const waiting = (id: string, on: WaitOn, repo = 'o/r'): Job =>
    ({ id, status: 'waiting_on', wait: { for: 'x', since, on }, source: { repo } }) as unknown as Job;
  const jobs = [
    waiting('on-job', { kind: 'job', jobId: 'j1' }),
    waiting('on-other-job', { kind: 'job', jobId: 'j2' }),
    waiting('on-item', { kind: 'item', number: 9 }),
    waiting('on-item-elsewhere', { kind: 'item', repo: 'x/y', number: 9 }),
    waiting('on-question', { kind: 'question', questionId: 'q1' }),
    waiting('on-grant', { kind: 'grant' }),
    waiting('on-sandbox', { kind: 'approval', of: 'sandbox' }),
    waiting('on-template', { kind: 'approval', of: 'template' }),
    waiting('outside', { kind: 'outside', what: 'job j1' }),
    { ...waiting('ran-again', { kind: 'job', jobId: 'j1' }), status: 'queued' } as Job,
  ];
  const woken = (e: Parameters<typeof settledBy>[0]) => {
    const s = settledBy(e);
    return s ? { note: s.note, jobs: jobs.filter((j) => waitsFor(j, s)).map((j) => j.id) } : undefined;
  };

  it('a job ending wakes the jobs waiting on it', () => {
    expect(woken({ type: 'job.finished', jobId: 'j1', data: { result: {} } })).toEqual({ note: 'job j1 finished', jobs: ['on-job'] });
    expect(woken({ type: 'job.failed', jobId: 'j1', data: { error: 'boom' } })).toEqual({ note: 'job j1 failed', jobs: ['on-job'] });
    expect(woken({ type: 'job.cancelled', jobId: 'j2', data: { reason: 'r' } })).toEqual({ note: 'job j2 was cancelled', jobs: ['on-other-job'] });
  });

  it('an item\'s issue closing wakes the jobs waiting on that item, in its repository', () => {
    expect(woken({ type: 'work_item.issue_closed', data: { key: 'https://github.com/o/r/issues/9', via: 'delivery' } }))
      .toEqual({ note: 'https://github.com/o/r/issues/9 was closed', jobs: ['on-item'] });
    expect(woken({ type: 'work_item.issue_closed', data: { key: 'https://github.com/x/y/issues/9', via: 'delivery' } })!.jobs).toEqual(['on-item-elsewhere']);
  });

  it('a question answered, closed, dismissed or expired wakes the jobs waiting on it', () => {
    expect(woken({ type: 'question.answered', data: { questionId: 'q1', by: 'human', answer: 'yes' } })).toEqual({ note: 'question q1 was answered', jobs: ['on-question'] });
    for (const type of ['question.closed', 'question.dismissed', 'question.expired'] as const) {
      expect(woken({ type, data: { questionId: 'q1' } })!.jobs).toEqual(['on-question']);
    }
    expect(woken({ type: 'question.answered', data: { questionId: 'q2' } })!.jobs).toEqual([]);
  });

  it('a grant given or denied wakes only the job it is for, when it waits on a grant', () => {
    expect(woken({ type: 'vault.granted', jobId: 'on-grant', data: { job: 'on-grant', key: 'k', by: 'p' } })).toEqual({ note: 'a vault grant was given', jobs: ['on-grant'] });
    expect(woken({ type: 'vault.grant_denied', jobId: 'on-grant', data: { job: 'on-grant', key: 'k', by: 'p' } })).toEqual({ note: 'a vault grant was denied', jobs: ['on-grant'] });
    expect(woken({ type: 'vault.granted', jobId: 'on-job', data: { job: 'on-job', key: 'k', by: 'p' } })!.jobs).toEqual([]);
  });

  it('a sandbox request approved or declined wakes its job; a template approval wakes the jobs waiting on one', () => {
    expect(woken({ type: 'vault.sandbox_approved', jobId: 'on-sandbox', data: { request: 'r', template: 't', by: 'p' } })).toEqual({ note: 'the sandbox request for t was approved', jobs: ['on-sandbox'] });
    expect(woken({ type: 'vault.sandbox_declined', jobId: 'on-sandbox', data: { request: 'r', template: 't', reason: 'no', by: 'p' } })!.jobs).toEqual(['on-sandbox']);
    expect(woken({ type: 'vault.approved', data: { template: 't', image: 'i', secrets: [], by: 'p' } })).toEqual({ note: 'template t was approved', jobs: ['on-template'] });
  });

  it('other events wake nothing', () => {
    expect(settledBy({ type: 'job.queued', jobId: 'j1', data: {} })).toBeUndefined();
    expect(settledBy({ type: 'job.finished', data: {} })).toBeUndefined();
  });
});
