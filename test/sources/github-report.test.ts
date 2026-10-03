import { describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { MARKER_RE, REPO, jobForIssue, question, setup } from './fixtures/github-support.ts';

function withIssue(over: Record<string, unknown> = {}) {
  const s = setup(over);
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('GitHub source report', () => {
  it('claimed: ensures the hopper labels, labels the issue claimed, comments with a marker', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { priority: 75, spec: { executor: 'herdr-claude', payload: { prompt: 'p', cwd: '/code/x' } } });
    const state = await source.report({ kind: 'claimed', job });
    expect(gh.labelsIn(REPO)).toEqual(expect.arrayContaining(['hopper:claimed', 'hopper:done', 'hopper:failed']));
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed']);
    const [c] = gh.commentsOn(REPO, 1);
    expect(c!.body.split('\n')[0]).toBe(`<!-- job-hopper v1 kind=claimed job=${job.id} -->`);
    expect(c!.body).toContain(`claimed this as job \`${job.id}\` (priority 75, executor herdr-claude, cwd /code/x)`);
    expect(state).toEqual({ claimCommentId: c!.id });
  });

  it('claimed twice with the returned state posts once', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1);
    const state = await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'claimed', job: { ...job, sourceState: { source: state } } });
    expect(gh.commentsOn(REPO, 1)).toHaveLength(1);
  });

  it('a retry after a crash (state lost) reuses the comment already carrying the marker', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1);
    const first = await source.report({ kind: 'claimed', job });
    const again = await source.report({ kind: 'claimed', job });
    expect(gh.commentsOn(REPO, 1)).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it('ensures labels once per repo per process', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.report({ kind: 'claimed', job: jobForIssue(1) });
    await source.report({ kind: 'claimed', job: jobForIssue(2) });
    expect(gh.calls.filter((c) => c.method === 'ensureLabel')).toHaveLength(3);
  });

  it('progress: one comment, edited in place; other state keys are kept', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { progress: 0.25, sourceState: { source: { claimCommentId: 5 } } });
    const s1 = await source.report({ kind: 'progress', job, message: 'reading code' });
    const s2 = await source.report({ kind: 'progress', job: { ...job, progress: 0.5, sourceState: { source: s1 } }, message: 'writing tests' });
    const comments = gh.commentsOn(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(MARKER_RE);
    expect(comments[0]!.body).toContain('50%');
    expect(comments[0]!.body).toContain('writing tests');
    expect(s2).toEqual({ claimCommentId: 5, progressCommentId: comments[0]!.id });
    expect(gh.calls.filter((c) => c.method === 'editComment')).toHaveLength(1);
  });

  it('question (human tier): comment with the question, the escalation trail and how to answer', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' });
    const state = await source.report({ kind: 'question', job, question: question(job.id) });
    const [c] = gh.commentsOn(REPO, 1);
    expect(c!.body.split('\n')[0]).toBe(`<!-- job-hopper v1 kind=question job=${job.id} question=q-1 -->`);
    expect(c!.body).toContain('Which database should I use?');
    expect(c!.body).toContain('opus · confident=no · risky=no');
    expect(c!.body).toContain('fable · confident=yes · risky=yes · rules: destructive');
    expect(c!.body).toContain('Reply to this issue to answer.');
    expect(state).toEqual({ questionComments: { 'q-1': c!.id } });
  });

  it('a second question keeps the first question comment id (whole state returned)', async () => {
    const { source } = withIssue();
    const job = jobForIssue(1);
    const s1 = await source.report({ kind: 'question', job, question: question(job.id) });
    const s2 = await source.report({ kind: 'question', job: { ...job, sourceState: { source: s1 } }, question: question(job.id, { id: 'q-2' }) });
    expect(Object.keys(s2.questionComments as object)).toEqual(['q-1', 'q-2']);
  });

  it('a question not at the human tier posts nothing', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1);
    expect(await source.report({ kind: 'question', job, question: question(job.id, { tier: 'opus' }) })).toEqual({});
    expect(gh.commentsOn(REPO, 1)).toHaveLength(0);
  });

  it('answered: says which tier answered and what', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1);
    await source.report({ kind: 'answered', job, question: question(job.id, { status: 'answered', answer: 'use sqlite', answeredBy: 'fable' }) });
    const [c] = gh.commentsOn(REPO, 1);
    expect(c!.body.split('\n')[0]).toBe(`<!-- job-hopper v1 kind=answered job=${job.id} question=q-1 -->`);
    expect(c!.body).toContain('Answered by fable: use sqlite');
  });

  it('finished: result comment, claimed → done', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: { summary: 'README added' } });
    await source.report({ kind: 'claimed', job });
    const state = await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    const last = gh.commentsOn(REPO, 1).at(-1)!;
    expect(last.body).toContain('README added');
    expect(state).toMatchObject({ finalCommentId: last.id });
  });

  it('failed: error comment, claimed → failed', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'empty issue body' });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'failed', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.commentsOn(REPO, 1).at(-1)!.body).toContain('empty issue body');
  });

  it('cancelled: comment with the recorded reason, claimed removed', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'cancelled', sourceState: { sync: { cancelReason: 'cancelled in UI' } } });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'cancelled', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.commentsOn(REPO, 1).at(-1)!.body).toContain('cancelled (cancelled in UI)');
  });

  it('a final report retried after a crash does not comment twice', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'ok' });
    await source.report({ kind: 'finished', job });
    await source.report({ kind: 'finished', job });
    expect(gh.commentsOn(REPO, 1)).toHaveLength(1);
  });

  it('truncates a comment to 60 000 chars with a note', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'r'.repeat(100000) });
    await source.report({ kind: 'finished', job });
    const [c] = gh.commentsOn(REPO, 1);
    expect(c!.body.length).toBeLessThanOrEqual(60000);
    expect(c!.body).toContain(`(truncated, see job ${job.id})`);
    expect(c!.body).toMatch(MARKER_RE);
  });

  it('an issue that is gone is a permanent SourceError with its status', async () => {
    const { gh, source } = withIssue();
    gh.deleteIssue(REPO, 1);
    const err = await source.report({ kind: 'finished', job: jobForIssue(1, { result: 'x' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ permanent: true, status: 404 });
  });

  it('a transient GitHub failure is a SourceError to retry', async () => {
    const { gh, source } = withIssue();
    gh.failNext('comment', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    const err = await source.report({ kind: 'claimed', job: jobForIssue(1) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ permanent: false, status: 502 });
  });

  it('a job without an issue reference is a permanent SourceError', async () => {
    const { source } = setup();
    const job = jobForIssue(1);
    delete job.source;
    await expect(source.report({ kind: 'claimed', job })).rejects.toMatchObject({ permanent: true });
  });
});
