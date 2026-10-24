// A done job's own open pull request that the issue's links in its repository miss (issue #2510): one in another repository
// that mentions the issue, opened by the job (issue #2004), or one the job opened through the hopper, whatever its text or
// branch says. The report names it, so its item is in PR open, never blocked for want of a pull request; so does the follow
// of a job whose report named none.
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const OTHER = 'owner/infra';
const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-02T11:00:00.000Z';

/** Issue #1 of REPO, and a done job of it; `opened`: the pull requests the job opened through the hopper, the newest first. */
function withIssue() {
  const opened: string[] = [];
  const s = setup({}, { openedPullRequests: () => opened });
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return { ...s, opened, job: jobForIssue(1, { status: 'finished' }) };
}

describe('the report names the job\'s own pull request the issue\'s links miss (issue #2510)', () => {
  it('its own open pull request in another repository that references the issue: named, PR open', async () => {
    const { gh, source, job } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Refs ${REPO}#1`, closes: false, createdAt: AFTER });
    expect(await source.report({ kind: 'finished', job })).toEqual({ follow: 'open', pullRequest: url });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:pr-ready');
  });

  it('a pull request in another repository the job did not open or push to: none named, blocked', async () => {
    const { gh, source, job } = withIssue();
    gh.mentionIssue(REPO, 1, { from: OTHER, text: `Refs ${REPO}#1`, closes: false, createdAt: BEFORE });
    expect(await source.report({ kind: 'finished', job })).toEqual({ follow: 'open' });
    expect(gh.issue(REPO, 1).labels).not.toContain('hopper:blocked');
  });

  it('a pull request the job opened through the hopper that names the issue nowhere: named, PR open', async () => {
    const { gh, source, job, opened } = withIssue();
    const pr = gh.openUnlinkedPullRequest(REPO, { createdAt: AFTER, headRef: 'feature/replay-held' });
    opened.push(pr.url);
    expect(await source.report({ kind: 'finished', job })).toEqual({ follow: 'open', pullRequest: pr.url });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:pr-ready');
  });

  it('one it opened in another repository, its branch updated from its base since: named', async () => {
    const { gh, source, job, opened } = withIssue();
    const pr = gh.openUnlinkedPullRequest(OTHER, { createdAt: AFTER, headRef: 'change' });
    gh.pushToPullRequest(pr.url, '2026-10-02T12:00:00.000Z');
    opened.push(pr.url);
    expect(await source.report({ kind: 'finished', job })).toEqual({ follow: 'open', pullRequest: pr.url });
  });

  it('one it opened through the hopper, closed since: none named, blocked', async () => {
    const { gh, source, job, opened } = withIssue();
    const pr = gh.openUnlinkedPullRequest(REPO, { createdAt: AFTER, headRef: 'feature/replay-held' });
    gh.closePullRequest(pr.url, AFTER);
    opened.push(pr.url);
    expect(await source.report({ kind: 'finished', job })).toEqual({ follow: 'open' });
    expect(gh.issue(REPO, 1).labels).not.toContain('hopper:blocked');
  });
});

describe('the follow finds the job\'s own pull request the issue\'s links miss (issue #2510)', () => {
  it('a report that named none: the follow names the one the job opened through the hopper, and follows it', async () => {
    const { gh, source, job, opened } = withIssue();
    const state = await source.report({ kind: 'finished', job });
    expect(state).toEqual({ follow: 'open' });
    const pr = gh.openUnlinkedPullRequest(REPO, { createdAt: AFTER, headRef: 'feature/replay-held' });
    opened.push(pr.url);
    expect(await source.follow!({ ...job, sourceState: { source: state } })).toMatchObject({ outcome: 'open', pullRequest: pr.url, state: { pullRequest: pr.url } });
  });

  it('a report that named none: the follow names the job\'s own one in another repository', async () => {
    const { gh, source, job } = withIssue();
    const state = await source.report({ kind: 'finished', job });
    const url = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Closes ${REPO}#1`, closes: false, createdAt: AFTER });
    expect(await source.follow!({ ...job, sourceState: { source: state } })).toMatchObject({ outcome: 'open', pullRequest: url });
  });
});
