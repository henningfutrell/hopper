// Own PR unfinished (issue #1265): a job that ended done while its own pull request had merge conflicts or was a draft is
// the hopper's to finish. The cause wins over Not complete; the assessor sends it back while under the retry limit, never
// grouped; its Continue tells the job the step its source names now.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type FailureRecord, type Job, type UnfinishedPullRequest, type WorkPullRequest } from '../../src/domain/types.ts';
import type { RerunResult } from '../../src/domain/ports.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause, OWN_PR_CHECKS_RED, OWN_PR_UNFINISHED, ownPullRequestCause } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';
import { createUnfinished } from '../../src/failures/unfinished.ts';

const PR = 'https://github.com/o/r/pull/1260';
const CONFLICTS = 'not complete: the issue https://github.com/o/r/issues/1244 is open, and no pull request in o/r that closes or references it is ready for review or merged since the job began: #1260 (open, merge conflicts), and PR #1260: merge conflicts with its base';
const DRAFT = 'not complete: the issue https://github.com/o/r/issues/1244 is open, and no pull request in o/r that closes or references it is ready for review or merged since the job began: #1260 (open, draft), and PR #1260: a draft';
const OTHER = 'not complete: the issue https://github.com/o/r/issues/1244 is open, and no pull request in o/r that closes or references it is ready for review or merged since the job began: #1199 (open, merge conflicts)';

function input(error: string, over: Partial<AssessInput> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, maxAttempts: 3 }, ...over,
  };
}

describe('the cause Own PR unfinished', () => {
  it('matches a miss that names its own pull request with merge conflicts or as a draft, ahead of Not complete', () => {
    expect(input(CONFLICTS).cause).toMatchObject({ id: OWN_PR_UNFINISHED, name: 'Own PR unfinished', decision: 'continue' });
    expect(input(DRAFT).cause?.id).toBe(OWN_PR_UNFINISHED);
    expect(input(OTHER).cause?.id).toBe('not-complete');
  });

  it('goes on to finish it, not a person, while under the retry limit; then a person, saying so', () => {
    expect(assess(input(CONFLICTS, { unfinishedFixes: 0 }))).toMatchObject({ cls: 'transient', decision: 'continue', auto: true });
    expect(assess(input(CONFLICTS, { unfinishedFixes: 2 })).summary).toMatch(/^Continues: it finishes its pull request\./);
    const spent = assess(input(CONFLICTS, { unfinishedFixes: 3 }));
    expect(spent).toMatchObject({ decision: 'person' });
    expect(spent.reasons.join(' ')).toMatch(/retry limit reached: sent back 3 times to finish its pull request/);
  });

  it('automatic Continue off: it waits for a person', () => {
    const settings = { ...DEFAULT_FAILURE_SETTINGS, auto: { ...DEFAULT_FAILURE_SETTINGS.auto, continue: false } };
    expect(assess(input(CONFLICTS, { settings }))).toMatchObject({ decision: 'continue', auto: false });
  });

  it('a Not complete with no own unfinished pull request is unchanged: a person', () => {
    expect(assess(input(OTHER))).toMatchObject({ cls: 'job', decision: 'person' });
  });

  it('never grouped, nor joined to an open problem of its signature', () => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'herdr-claude' }];
    const a = assess(input(CONFLICTS, { recent, open: { id: 'p1', title: 'Recurring', decision: 'hold' } }));
    expect(a).toMatchObject({ decision: 'continue' });
    expect(a.problem).toBeUndefined();
  });
});

describe('its Continue', () => {
  const job = { id: 'j1', workTree: '/work/j1' } as unknown as Job;
  const record = { id: 'f1', jobId: 'j1', causeId: OWN_PR_UNFINISHED, pending: 'continue' } as FailureRecord;

  function harness(finish: () => Promise<UnfinishedPullRequest | undefined>, resumable = true) {
    const continued: string[] = [];
    const reruns: string[] = [];
    const ok = (): RerunResult => ({ ok: true, job });
    const u = createUnfinished({
      store: { jobs: { get: (id: string) => (id === job.id ? job : undefined) } } as never,
      unfinishedPullRequest: finish, resumable: () => resumable,
      continueJob: async (_id, brief) => { continued.push(brief); return ok(); },
      rerun: async (_id, _by, brief) => { reruns.push(brief ?? ''); return ok(); },
    });
    return { u, continued, reruns };
  }

  it('is only this cause\'s', () => {
    expect(harness(async () => undefined).u.continueOf({ ...record, causeId: 'timed-out' })).toBeUndefined();
  });

  it('conflicts: its own session, told to rebase onto the base branch and resolve them', async () => {
    const h = harness(async () => ({ pullRequest: PR, step: 'rebase' }));
    expect(await h.u.continueOf(record)).toMatchObject({ ok: true });
    const brief = h.continued[0]!;
    expect(brief).toMatch(/same session and work tree/);
    expect(brief).toContain(`Your pull request ${PR} has merge conflicts with its base branch.`);
    expect(brief).toContain('Rebase your branch onto it.');
    expect(brief).toContain('Make the checks of the pull request pass.');
    expect(brief).toContain('Do not open a new pull request.');
  });

  it('no session to resume: a new job of its item, told the same', async () => {
    const h = harness(async () => ({ pullRequest: PR, step: 'rebase' }), false);
    await h.u.continueOf(record);
    expect(h.continued).toEqual([]);
    expect(h.reruns[0]).toMatch(/^The hopper runs this issue again: the earlier job's pull request .*1260 is not ready for review\./);
  });

  it('its source cannot tell now: asked again later', async () => {
    const h = harness(async () => { throw new Error('GitHub is down'); });
    expect(await h.u.continueOf(record)).toMatchObject({ ok: false, reason: 'source' });
    expect(h.continued).toEqual([]);
  });
});

// Issue #1522: the work state decides, not the failure text alone, so a wording drift cannot open Needs a person.
describe('the cause the job\'s work shows', () => {
  const pr = (over: Partial<WorkPullRequest> = {}): WorkPullRequest =>
    ({ url: PR, number: 1260, by: 'opened', state: 'open', draft: false, conflicting: false, ...over });
  const work = (...pullRequests: WorkPullRequest[]) => ({ item: 'open' as const, pullRequests });

  it('its own or updated open pull request with merge conflicts, or a draft: Own PR unfinished', () => {
    expect(ownPullRequestCause(work(pr({ conflicting: true })))).toBe(OWN_PR_UNFINISHED);
    expect(ownPullRequestCause(work(pr({ by: 'updated', conflicting: true })))).toBe(OWN_PR_UNFINISHED);
    expect(ownPullRequestCause(work(pr({ draft: true })))).toBe(OWN_PR_UNFINISHED);
  });

  it('its own open pull request, ready but for its red checks: Own PR checks red', () => {
    expect(ownPullRequestCause(work(pr({ checks: 'failing' })))).toBe(OWN_PR_CHECKS_RED);
    expect(ownPullRequestCause(work(pr({ checks: 'failing' }), pr({ url: `${PR}1`, number: 12601, conflicting: true })))).toBe(OWN_PR_UNFINISHED);
  });

  it('none: no pull request, only closed ones, a ready one, or the item not open', () => {
    expect(ownPullRequestCause(work())).toBeUndefined();
    expect(ownPullRequestCause(work(pr({ state: 'closed', conflicting: true })))).toBeUndefined();
    expect(ownPullRequestCause(work(pr({ checks: 'pending' })))).toBeUndefined();
    expect(ownPullRequestCause({ item: 'closed', pullRequests: [pr({ conflicting: true })] })).toBeUndefined();
    expect(ownPullRequestCause(work(pr({ conflicting: true }), pr({ url: `${PR}1`, number: 12601, state: 'merged' })))).toBeUndefined();
  });
});
