import { describe, expect, it } from 'vitest';
import { GitHubApiError, createFakeGitHub } from '../../src/sources/github/index.ts';

describe('in-memory fake GitHub', () => {
  it('creates issues with their labels, and lists open labelled ones per repo', async () => {
    const gh = createFakeGitHub();
    const a = gh.createIssue({ repo: 'h/a', title: 'A', body: 'do a', labels: ['hopper'] });
    gh.createIssue({ repo: 'h/a', title: 'B', labels: [] });
    gh.createIssue({ repo: 'x/b', title: 'C', labels: ['hopper'] });
    expect(a).toMatchObject({ repo: 'h/a', number: 1, url: 'https://github.com/h/a/issues/1', author: 'owner', state: 'open' });
    expect((await gh.listOpenIssues('h/a', 'hopper')).map((i) => i.title)).toEqual(['A']);
  });

  it('comment ids are numeric and increasing; addComment is by anyone', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    const c1 = gh.addComment('h/a', 1, 'me', 'mine');
    const c2 = gh.addComment('h/a', 1, 'stranger', 'theirs');
    expect(c2.id).toBeGreaterThan(c1.id);
    expect((await gh.listComments('h/a', 1)).map((c) => [c.author, c.body])).toEqual([['me', 'mine'], ['stranger', 'theirs']]);
  });

  it('adding a label the repo does not have fails like GitHub (422, permanent)', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    await expect(gh.addLabels('h/a', 1, ['hopper:done'])).rejects.toMatchObject({ permanent: true, status: 422 });
    await gh.ensureLabel('h/a', 'hopper:done', '0e8a16', 'done');
    await gh.addLabels('h/a', 1, ['hopper:done']);
    expect(gh.issue('h/a', 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.labelsIn('h/a')).toContain('hopper:done');
  });

  it('a deleted issue is 404; a closed one reads closed', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    gh.closeIssue('h/a', 1);
    gh.deleteIssue('h/a', 2);
    expect((await gh.getIssue('h/a', 1)).state).toBe('closed');
    await expect(gh.getIssue('h/a', 2)).rejects.toMatchObject({ permanent: true, status: 404 });
    await expect(gh.listComments('h/a', 2)).rejects.toMatchObject({ status: 404 });
  });

  it('closeByPullRequest closes the issue and closingPullRequest returns that pull request; a person closing it is none', async () => {
    const gh = createFakeGitHub();
    for (let i = 0; i < 2; i++) gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    gh.closeByPullRequest('h/a', 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    gh.closeIssue('h/a', 2);
    expect((await gh.getIssue('h/a', 1)).state).toBe('closed');
    expect(await gh.closingPullRequest('h/a', 1)).toEqual({
      url: 'https://github.com/h/a/pull/1001', createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z',
    });
    expect(await gh.closingPullRequest('h/a', 2)).toBeUndefined();
  });

  it('openPullRequest leaves the issue open and openClosingPullRequests lists it; a merge takes it off the list', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    const pr = gh.openPullRequest('h/a', 1, { createdAt: '2026-10-02T10:30:00.000Z', isDraft: true });
    expect(pr).toEqual({ url: 'https://github.com/h/a/pull/1001', createdAt: '2026-10-02T10:30:00.000Z', isDraft: true });
    expect(gh.issue('h/a', 1).state).toBe('open');
    expect(await gh.openClosingPullRequests('h/a', 1)).toEqual([pr]);
    gh.closeByPullRequest('h/a', 1, { createdAt: '2026-10-02T10:30:00.000Z', mergedAt: '2026-10-02T11:00:00.000Z' });
    expect(await gh.openClosingPullRequests('h/a', 1)).toEqual([]);
  });

  it('failNext fails exactly the next call of that method', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    gh.failNext('listOpenIssues', new GitHubApiError('boom', false, 502));
    await expect(gh.listOpenIssues('h/a', 'hopper')).rejects.toThrow('boom');
    expect(await gh.listOpenIssues('h/a', 'hopper')).toHaveLength(1);
  });

  it('project items keep their order as index; a project can be set to fail', async () => {
    const gh = createFakeGitHub();
    gh.setProjectItems('h', 3, [{ url: 'u1', fields: { priority: 'P0' } }, { url: 'u2' }]);
    expect(await gh.projectItems('h', 3)).toEqual([{ url: 'u1', index: 0, fields: { priority: 'P0' } }, { url: 'u2', index: 1, fields: {} }]);
    gh.setProjectItems('h', 4, new GitHubApiError('missing read:project scope', true));
    await expect(gh.projectItems('h', 4)).rejects.toThrow('read:project');
  });

  it('logs every API call with its arguments', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    await gh.getIssue('h/a', 1);
    expect(gh.calls).toEqual([{ method: 'getIssue', args: ['h/a', 1] }]);
  });
});
