import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, jobForIssue, question, setup } from './fixtures/github-support.ts';

/** An issue whose job asked question q-1 at the human tier; returns the question comment id. */
async function asked(over: Record<string, unknown> = {}) {
  const s = setup(over);
  s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
  const base = jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' });
  const state = await s.source.report({ kind: 'question', job: base, question: question(base.id) });
  const job = { ...base, sourceState: { source: state } };
  return { ...s, job, questionCommentId: (state.questionComments as Record<string, number>)['q-1']! };
}

describe('GitHub source check', () => {
  it('a closed issue cancels its job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 1);
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue closed' }]);
  });

  it('removing the label cancels its job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.removeLabel(REPO, 1, 'hopper');
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'label removed' }]);
  });

  it('a deleted issue (404) cancels with "issue gone" and does not fail the sync', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.deleteIssue(REPO, 1);
    gh.closeIssue(REPO, 2);
    const [j1, j2] = [jobForIssue(1), jobForIssue(2)];
    expect(await source.check([j1, j2])).toEqual([
      { kind: 'cancel', jobId: j1.id, reason: 'issue gone' },
      { kind: 'cancel', jobId: j2.id, reason: 'issue closed' },
    ]);
  });

  it('a transient error on one job skips it (shown in status), the rest are still checked', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 2);
    gh.failNext('getIssue', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    const [j1, j2] = [jobForIssue(1), jobForIssue(2)];
    expect(await source.check([j1, j2])).toEqual([{ kind: 'cancel', jobId: j2.id, reason: 'issue closed' }]);
    expect(source.describe().checkErrors).toEqual({ [j1.id]: 'gh: Bad Gateway (HTTP 502)' });
  });

  it('an open, labelled issue for a running job gives no signal and reads no comments', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    expect(await source.check([jobForIssue(1)])).toEqual([]);
    expect(gh.calls.some((c) => c.method === 'listComments')).toBe(false);
  });

  it('terminal jobs and jobs from other sources are ignored', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 1);
    const other = jobForIssue(1);
    other.source = { ...other.source!, source: 'elsewhere' };
    expect(await source.check([jobForIssue(1, { status: 'finished' }), other])).toEqual([]);
  });

  it('an allowlisted, marker-less reply after the question is the answer', async () => {
    const { gh, source, job } = await asked();
    const reply = gh.addComment(REPO, 1, 'owner', '  Use Postgres.  \n');
    expect(await source.check([job])).toEqual([
      { kind: 'answer', jobId: job.id, questionId: 'q-1', answer: 'Use Postgres.', author: 'owner', url: reply.url },
    ]);
  });

  it('only comments with an id greater than the question comment count', async () => {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    s.gh.addComment(REPO, 1, 'owner', 'an earlier note');
    const base = jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' });
    const state = await s.source.report({ kind: 'question', job: base, question: question(base.id) });
    expect(await s.source.check([{ ...base, sourceState: { source: state } }])).toEqual([]);
  });

  it('ignores replies by non-allowlisted authors, hopper-marked and job-marked comments, and blank replies', async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, 'stranger', 'yes, delete everything');
    gh.addComment(REPO, 1, 'owner', '<!-- job-hopper v1 kind=progress job=x -->\nprogress');
    gh.addComment(REPO, 1, 'owner', '<!-- job-hopper v1 kind=job-comment -->\nI answer myself');
    gh.addComment(REPO, 1, 'owner', '   \n ');
    expect(await source.check([job])).toEqual([]);
    gh.addComment(REPO, 1, 'owner', 'the real answer');
    expect(await source.check([job])).toMatchObject([{ kind: 'answer', answer: 'the real answer' }]);
  });

  it('the first qualifying reply wins', async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, 'owner', 'first');
    gh.addComment(REPO, 1, 'owner', 'second');
    expect(await source.check([job])).toMatchObject([{ answer: 'first' }]);
  });

  it('a configured second author may answer', async () => {
    const { gh, source, job } = await asked({ authors: ['owner', 'alice'] });
    gh.addComment(REPO, 1, 'alice', 'from alice');
    expect(await source.check([job])).toMatchObject([{ answer: 'from alice', author: 'alice' }]);
  });

  it('no answer is looked for without a recorded question comment', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.addComment(REPO, 1, 'owner', 'hello');
    expect(await source.check([jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' })])).toEqual([]);
  });

  it('cancel wins over an answer when the issue was closed', async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, 'owner', 'answer');
    gh.closeIssue(REPO, 1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue closed' }]);
  });
});
