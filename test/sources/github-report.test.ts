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
  it('claimed: ensures the claim label, labels the issue claimed, posts nothing; state unchanged', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { priority: 75, sourceState: { source: { claimCommentId: 5 } } });
    const state = await source.report({ kind: 'claimed', job });
    expect(gh.labelsIn(REPO)).toContain('hopper:claimed');
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
    expect(gh.calls.filter((c) => c.method === 'ensureLabel')).toHaveLength(1);
  });

  it('finished with the issue open and no pull request open: the claim comes off and no label goes on, no comment, the follow looks again (issues #187, #579, #1891)', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, {
      id: 'abcdef12-3456-7890-abcd-ef1234567890', status: 'finished', result: { summary: 'README added, mindless prose' },
      startedAt: '2026-10-02T10:00:00.000Z', finishedAt: '2026-10-02T10:04:12.000Z',
    });
    const claimed = await source.report({ kind: 'claimed', job });
    gh.calls.length = 0;
    const state = await source.report({ kind: 'finished', job });
    // No open pull request: never hopper:pr-ready with none (issue #1891), and no hopper:blocked (issue #2693).
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    // No ready pull request closes it: one that references it, or one named for it on its branch, is looked for (issue #637).
    expect(gh.calls.map((c) => c.method)).toEqual(['getIssue', 'openClosingPullRequests', 'referencingPullRequests', 'openPullRequests', 'removeLabels']);
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(state).toEqual({ ...claimed, follow: 'open' });
  });

  it('finished with a draft pull request open: claimed → pr-ready, the pull request named to follow (issue #1891)', async () => {
    const { gh, source } = withIssue();
    const pr = gh.openPullRequest(REPO, 1, { createdAt: '2026-10-02T10:01:00.000Z', isDraft: true });
    const job = jobForIssue(1, { status: 'finished', result: 'ok' });
    const state = await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    expect(state).toEqual({ pullRequest: pr.url, follow: 'open' });
  });

  it('finished, a proposal\'s job whose follow-ons go on with its work: the issue stays claimed, nothing to follow (issue #859)', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished', result: { proposal: { id: 'p1', version: 1, decision: 'accept', followOns: [{ path: '1', jobId: 'j2' }] } } });
    const claimed = await source.report({ kind: 'claimed', job });
    gh.calls.length = 0;
    const state = await source.report({ kind: 'finished', job: { ...job, sourceState: { source: claimed } } });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper', 'hopper:claimed'] });
    expect(gh.calls).toEqual([]);
    expect(state).toEqual(claimed);
  });

  it('finished on an issue already closed (by the job’s own pull request): labels settle, the close is harmless', async () => {
    const { gh, source } = withIssue();
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'ok' }) });
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'closed', labels: ['hopper', 'hopper:done'] });
  });

  it('finished on an issue closed as complete: the state records that the report put hopper:done on (issue #1892 part 24)', async () => {
    const { gh, source } = withIssue();
    gh.closeIssue(REPO, 1);
    const state = await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'ok', sourceState: { source: { claimCommentId: 5 } } }) });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(state).toEqual({ claimCommentId: 5, doneReported: true });
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

  it('failed while the hopper fixes it (issue #1230: its own pull request\'s checks red): the issue stays as it is, claimed, never hopper:failed', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'not complete: the issue is open, and PR #7: checks failed: test' });
    const claimed = await source.report({ kind: 'claimed', job });
    const labels = gh.issue(REPO, 1).labels;
    gh.calls.length = 0;
    expect(await source.report({ kind: 'failed', job: { ...job, sourceState: { source: claimed } }, fixing: true })).toEqual(claimed);
    expect(gh.issue(REPO, 1).labels).toEqual(labels);
    expect(gh.calls).toEqual([]);
  });

  it('rerun: the end labels go and the issue comes back as an item for the new job, at once; no comment (issues #313, #354)', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed', error: 'scratch dir timed out' });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'failed', job });
    gh.calls.length = 0;
    const item = await source.rerun!(job);
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect(gh.commentsOn(REPO, 1)).toEqual([]);
    expect(gh.calls.map((c) => c.method)).not.toContain('reopenIssue');
    expect(item).toMatchObject({ key: job.source!.key, repo: REPO, number: 1, labels: ['hopper'] });
  });

  it('rerun of a closed issue reopens it, so the new job can finish against it (issue #354)', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'finished' });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'finished', job });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T09:30:00Z', mergedAt: '2026-10-02T09:40:00Z' });
    const item = await source.rerun!(job);
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper'] });
    expect(gh.calls.filter((c) => c.method === 'reopenIssue').map((c) => c.args)).toEqual([[REPO, 1]]);
    expect(item.key).toBe(job.source!.key);
  });

  it('rerun puts the source label back when it was taken off, so the new job is not cancelled for it (issue #354)', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed' });
    await source.report({ kind: 'claimed', job });
    await source.report({ kind: 'failed', job });
    gh.removeLabel(REPO, 1, 'hopper');
    gh.addLabel(REPO, 1, 'hopper:rejected');
    await source.rerun!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('rerun that GitHub refuses throws a SourceError with its reason', async () => {
    const { gh, source } = withIssue();
    const job = jobForIssue(1, { status: 'failed' });
    await source.report({ kind: 'failed', job });
    gh.failNext('removeLabels', new GitHubApiError('gh: Resource not accessible (HTTP 403)', true, 403));
    const err = await source.rerun!(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).permanent).toBe(true);
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
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
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

  it('a transient GitHub failure of a read is a SourceError to retry (a label refused waits in the outbox, issue #1892)', async () => {
    const { gh, source } = withIssue();
    gh.failNext('getIssue', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
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
