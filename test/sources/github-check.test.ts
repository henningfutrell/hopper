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

  it('an issue closed by the merge of a pull request opened after the job was created gives no signal: the job ends on its own', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    const [running, waiting] = [jobForIssue(1), jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' })];
    expect(await source.check([running, waiting])).toEqual([]);
  });

  it('an issue closed as completed after the job was created — a commit, or no code — gives a started job no signal; a waiting one is cancelled (issue #350)', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.closeIssue(REPO, 1, 'owner', { at: '2026-10-02T11:00:00.000Z' });
    const [running, asking, queued] = [jobForIssue(1), jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' }), jobForIssue(1, { status: 'queued' })];
    expect(await source.check([running, asking, queued])).toEqual([{ kind: 'cancel', jobId: queued.id, reason: 'issue closed' }]);
  });

  it('an issue closed as not planned cancels a started job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.closeIssue(REPO, 1, 'owner', { at: '2026-10-02T11:00:00.000Z', reason: 'not_planned' });
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue closed' }]);
  });

  it('an issue closed by the merge of a pull request opened before the job was created cancels the job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T09:00:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue closed' }]);
  });

  it('a transient error asking what closed the issue skips the job: no cancel this sync', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeByPullRequest(REPO, 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    gh.failNext('closingPullRequest', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([]);
    expect(source.describe().checkErrors).toEqual({ [job.id]: 'gh: Bad Gateway (HTTP 502)' });
  });

  it('removing the label cancels its job', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.removeLabel(REPO, 1, 'hopper');
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'label removed' }]);
  });

  it('the backburner label cancels a waiting job, never a running one', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', 'hopper:backburner'] });
    const [queued, held, running] = [jobForIssue(1, { status: 'queued' }), jobForIssue(1, { status: 'held' }), jobForIssue(2, { status: 'running' })];
    expect(await source.check([queued, held, running])).toEqual([
      { kind: 'cancel', jobId: queued.id, reason: 'backburner' },
      { kind: 'cancel', jobId: held.id, reason: 'backburner' },
    ]);
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

  // Issue #52: the boot after an install read an unparsable app key, every check failed
  // permanently, and every active job was cancelled as "issue gone".
  it.each([
    ['the app is not configured', new GitHubApiError('get owner/repo#1: no app configured: no private key', true)],
    ['the app credentials are refused (401)', new GitHubApiError("get owner/repo#1: GitHub rejected the app's credentials (401: Bad credentials)", true, 401)],
    ['the app is not installed on the repo', new GitHubApiError('app not installed on owner/repo', true)],
    ['access is forbidden (403)', new GitHubApiError('gh: Resource not accessible by integration (HTTP 403)', true, 403)],
    ['a token scope is missing', new GitHubApiError('gh: missing required scopes [repo]', true)],
  ])('a permanent error that does not say the issue is gone (%s) cancels nothing: the job is skipped and shown', async (_what, error) => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.failNext('getIssue', error);
    gh.failNext('getIssue', error);
    const [running, waiting] = [jobForIssue(1), jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' })];
    expect(await source.check([running, waiting])).toEqual([]);
    expect(source.describe().checkErrors).toEqual({ [running.id]: error.message, [waiting.id]: error.message });
  });

  it('a 410 on the issue cancels with "issue gone"', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.failNext('getIssue', new GitHubApiError('gh: This issue was deleted (HTTP 410)', true, 410));
    const job = jobForIssue(1);
    expect(await source.check([job])).toEqual([{ kind: 'cancel', jobId: job.id, reason: 'issue gone' }]);
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

  describe('assignment drift (issue #387)', () => {
    const ofIssue = (n: number, over: Parameters<typeof jobForIssue>[1] = {}) => {
      const j = jobForIssue(n, over);
      return { ...j, source: { ...j.source!, assignee: 'owner' } };
    };

    it('unassigned while waiting: cancel, "unassigned"; while running, on a question or operator-led: an unassigned signal', async () => {
      const { gh, source } = setup();
      for (let i = 0; i < 4; i++) gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper', 'hopper:claimed'] });
      const [queued, running, asking, led] = [
        ofIssue(1, { status: 'queued' }), ofIssue(2), ofIssue(3, { status: 'waiting_answer', questionId: 'q' }), ofIssue(4, { status: 'operator_led' }),
      ];
      expect(await source.check([queued, running, asking, led])).toEqual([
        { kind: 'cancel', jobId: queued.id, reason: 'unassigned' },
        { kind: 'unassigned', jobId: running.id },
        { kind: 'unassigned', jobId: asking.id },
        { kind: 'unassigned', jobId: led.id },
      ]);
    });

    it('a flagged job assigned again: a reassigned signal; one never flagged: none', async () => {
      const { gh, source } = setup();
      gh.createIssue({ repo: REPO, labels: ['hopper'] });
      gh.createIssue({ repo: REPO, labels: ['hopper'] });
      const flagged = { ...ofIssue(1), sourceState: { sync: { unassignedAt: '2026-10-02T10:00:00.000Z' } } };
      expect(await source.check([flagged, ofIssue(2)])).toEqual([{ kind: 'reassigned', jobId: flagged.id }]);
    });

    it('a job taken before assignment intake (no assignee) is never cancelled or flagged for having none', async () => {
      const { gh, source } = setup();
      gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
      gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
      expect(await source.check([jobForIssue(1, { status: 'queued' }), jobForIssue(2)])).toEqual([]);
    });
  });
});

