// Issue #1245: a job's own wait always names what it waits on, typed — a pull request, a job, an item, a person's
// question, an approval, a grant, its own command, or an outside event. A job never enters `waiting_on` without it. Pure.
import { describe, expect, it } from 'vitest';
import { mergedWaiter, waitEntryProblem, waitOnLabel, waitOnOf, type WaitOn } from '../../src/domain/wait-on.ts';
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
    expect(jobs.filter((j) => mergedWaiter(j, 'https://github.com/o/r/pull/12')).map((j) => j.id)).toEqual(['a', 'b', 'e']);
  });
});
