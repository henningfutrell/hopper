import { describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

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
    expect(gh.labelsIn(REPO)).toEqual(expect.arrayContaining(['hopper:claimed', 'hopper:done', 'hopper:failed', 'hopper:rejected']));
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
    expect(gh.calls.filter((c) => c.method === 'ensureLabel')).toHaveLength(4);
  });

  it('finished: claimed → done, no comment, the issue left to the merge that closes it (issue #187); state unchanged', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, {
      id: 'abcdef12-3456-7890-abcd-ef1234567890', status: 'finished', result: { summary: 'README added, mindless prose' },
      startedAt: '2026-10-02T10:00:00.000Z', finishedAt: '2026-10-02T10:04:12.000Z',
    });
    const claimed = await source.report({ kind: 'claimed', job });
    gh.calls.length = 0;
    const state = await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(gh.calls.map((c) => c.method)).toEqual(['removeLabels', 'addLabels']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(state).toEqual(claimed);
  });

  it('finished on an issue already closed (by the job’s own pull request): labels settle, the close is harmless', async () => {
    const { gh, source } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'ok' }) });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'closed', labels: ['hopper', 'hopper:done'] });
  });

  it('failed: label only, claimed → failed, no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'empty issue body' });
    const claimed = await source.report({ kind: 'claimed', job });
    const state = await source.report({ kind: 'failed', job: { ...job, sourceState: { source: claimed } } });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(state).toEqual(claimed);
  });

  it('retried: the failed and claimed labels go, so the issue is offered again; no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'scratch dir timed out' });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'failed', job });
    gh.calls.length = 0;
    await source.report({ kind: 'retried', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(gh.calls.map((c) => c.method)).toEqual(['removeLabels']);
  });

  it('cancelled: claimed removed, no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'cancelled', sourceState: { sync: { cancelReason: 'cancelled in UI' } } });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'cancelled', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
  });

  it('finished twice: labels settle once, still no comment', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: 'ok' });
    const state = await source.report({ kind: 'finished', job });
    await source.report({ kind: 'finished', job: { ...job, sourceState: { source: state } } });
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('a huge result never reaches the issue', async () => {
    const { gh, source } = withIssue();
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'r'.repeat(100000) }) });
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
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
    gh.failNext('addLabels', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
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
