import { describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { MARKER_RE, REPO, jobForIssue, setup } from './fixtures/github-support.ts';

function withIssue(over: Record<string, unknown> = {}) {
  const s = setup(over);
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('GitHub source report', () => {
  it('claimed: ensures the hopper labels, labels the issue claimed, posts nothing; state unchanged', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { priority: 75, sourceState: { source: { claimCommentId: 5 } } });
    const state = await source.report({ kind: 'claimed', job });
    expect(gh.labelsIn(REPO)).toEqual(expect.arrayContaining(['hopper:claimed', 'hopper:done', 'hopper:failed']));
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed']);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(state).toEqual({ claimCommentId: 5 });
  });

  it('ensures labels once per repo per process', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.report({ kind: 'claimed', job: jobForIssue(1) });
    await source.report({ kind: 'claimed', job: jobForIssue(2) });
    expect(gh.calls.filter((c) => c.method === 'ensureLabel')).toHaveLength(3);
  });

  it('finished: the one comment — a completion status with the result, marked; claimed → done', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: { summary: 'README added' } });
    await source.report({ kind: 'claimed', job });
    const state = await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    const comments = gh.commentsOn(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.split('\n')[0]).toBe(`<!-- job-hopper v1 kind=finished job=${job.id} -->`);
    expect(comments[0]!.body).toContain('README added');
    expect(state).toEqual({ finalCommentId: comments[0]!.id });
  });

  it('failed: label only, claimed → failed, no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'empty issue body' });
    const claimed = await source.report({ kind: 'claimed', job });
    const state = await source.report({ kind: 'failed', job: { ...job, sourceState: { source: claimed } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(state).toEqual(claimed);
  });

  it('cancelled: claimed removed, no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'cancelled', sourceState: { sync: { cancelReason: 'cancelled in UI' } } });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'cancelled', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
  });

  it('finished twice with the returned state posts once', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'ok' });
    const state = await source.report({ kind: 'finished', job });
    await source.report({ kind: 'finished', job: { ...job, sourceState: { source: state } } });
    expect(gh.commentsOn(REPO, 1)).toHaveLength(1);
  });

  it('a final report retried after a crash (state lost) reuses the comment carrying the marker', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'ok' });
    const first = await source.report({ kind: 'finished', job });
    const again = await source.report({ kind: 'finished', job });
    expect(gh.commentsOn(REPO, 1)).toHaveLength(1);
    expect(again).toEqual(first);
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
    const err = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'x' }) }).catch((e: unknown) => e);
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
