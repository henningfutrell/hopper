import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

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

  it('a reply on the issue is never an answer: a waiting job gives no signal and reads no comments', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.addComment(REPO, 1, 'owner', 'Use Postgres.');
    expect(await source.check([jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' })])).toEqual([]);
    expect(gh.calls.some((c) => c.method === 'listComments')).toBe(false);
  });

  it('closing the issue cancels a job waiting on an answer', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    const job = jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' });
    gh.addComment(REPO, 1, 'owner', 'answer');
    gh.closeIssue(REPO, 1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue closed' }]);
  });
});
