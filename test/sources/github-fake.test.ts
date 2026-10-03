import { describe, expect, it } from 'vitest';
import { GitHubApiError, createFakeGitHub } from '../../src/sources/github/index.ts';

describe('in-memory fake GitHub', () => {
  it('creates issues with their labels, and lists open labelled ones per repo and per owner', async () => {
    const gh = createFakeGitHub();
    const a = gh.createIssue({ repo: 'h/a', title: 'A', body: 'do a', labels: ['hopper'] });
    gh.createIssue({ repo: 'h/a', title: 'B', labels: [] });
    gh.createIssue({ repo: 'x/b', title: 'C', labels: ['hopper'] });
    expect(a).toMatchObject({ repo: 'h/a', number: 1, url: 'https://github.com/h/a/issues/1', author: 'owner', state: 'open' });
    expect((await gh.listOpenIssues('h/a', 'hopper')).map((i) => i.title)).toEqual(['A']);
    expect((await gh.searchOpenIssues({ owners: ['h'], label: 'hopper' })).map((i) => i.title)).toEqual(['A']);
    expect(await gh.whoami()).toBe('owner');
  });

  it('comment ids are numeric and increasing; posts are by the gh user, addComment by anyone', async () => {
    const gh = createFakeGitHub({ login: 'me' });
    gh.createIssue({ repo: 'h/a', labels: ['hopper'] });
    const c1 = await gh.comment('h/a', 1, 'mine');
    const c2 = gh.addComment('h/a', 1, 'stranger', 'theirs');
    expect(c2.id).toBeGreaterThan(c1.id);
    expect((await gh.listComments('h/a', 1)).map((c) => [c.author, c.body])).toEqual([['me', 'mine'], ['stranger', 'theirs']]);
    await gh.editComment('h/a', c1.id, 'edited');
    expect(gh.commentsOn('h/a', 1)[0]!.body).toBe('edited');
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
    await expect(gh.comment('h/a', 2, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('failNext fails exactly the next call of that method', async () => {
    const gh = createFakeGitHub();
    gh.failNext('whoami', new GitHubApiError('boom', false, 502));
    await expect(gh.whoami()).rejects.toThrow('boom');
    expect(await gh.whoami()).toBe('owner');
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
