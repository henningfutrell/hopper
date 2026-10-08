import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { REPO, discoverOne, setup } from './fixtures/github-support.ts';

describe('GitHub source discover', () => {
  it('turns an open labelled issue assigned to the account into one item keyed by its URL', async () => {
    const { gh, source } = setup({ model: 'claude-sonnet-5' });
    gh.createIssue({ repo: REPO, title: 'Add a README', body: 'Write it.', labels: ['hopper'] });
    const item = await discoverOne(source);
    expect(item).toMatchObject({
      key: `https://github.com/${REPO}/issues/1`, url: `https://github.com/${REPO}/issues/1`, title: 'Add a README', body: 'Write it.',
      author: 'owner', labels: ['hopper'], repo: REPO, number: 1, executor: 'herdr-claude', model: 'claude-sonnet-5',
      priority: 50, priorityReason: 'default',
    });
    // Issue #361: no path: the work tree is the machine's that runs the job.
    expect(item).not.toHaveProperty('cwd');
    expect(item).not.toHaveProperty('defaultCwd');
    expect(item.invalid).toBeUndefined();
    expect(gh.calls.filter((c) => c.method === 'listOpenIssues').map((c) => c.args)).toEqual([[REPO, 'hopper']]);
  });

  it('takes an issue filed by anyone when it is assigned to the account (issue #387)', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, author: 'stranger', assignees: ['someone', 'Owner'], labels: ['hopper'] });
    expect((await source.discover()).map((i) => [i.author, i.assignee])).toEqual([['stranger', 'owner']]);
  });

  it('never takes an issue not assigned to the account, whoever filed it', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, author: 'owner', assignees: [], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, author: 'owner', assignees: ['someone'], labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
  });

  it('a rejected issue is not taken again until it is assigned to the account after the rejection (issue #387)', async () => {
    const rejectedAt = '2026-10-02T09:30:00.000Z';
    const rejections = (keys: string[]) => new Map(keys.map((k) => [k, { at: rejectedAt, assignee: 'owner' }]));
    const { gh, source } = setup({}, { rejections });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.assign(REPO, 2, 'owner', '2026-10-02T09:45:00.000Z');
    expect((await source.discover()).map((i) => i.number)).toEqual([2]);
  });

  it('a rejection recorded before assignment intake (no assignee) leaves the issue to its labels', async () => {
    const rejections = (keys: string[]) => new Map(keys.map((k) => [k, { at: '2026-10-02T09:30:00.000Z' }]));
    const { gh, source } = setup({}, { rejections });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('skips issues already done or failed, closed, or without the label', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:failed'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.closeIssue(REPO, 3);
    gh.createIssue({ repo: REPO, labels: ['other'] });
    expect(await source.discover()).toEqual([]);
  });

  it('skips issues on the backburner until the label is removed', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    expect(await source.discover()).toEqual([]);
    gh.removeLabel(REPO, 1, 'hopper:backburner');
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('with no repositories it reads nothing: never a search', async () => {
    const { gh, source } = setup({ repos: [] });
    gh.createIssue({ repo: 'owner/a', labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it('a claimed issue with no local job and no holder is skipped with its reason; one with a job is returned', async () => {
    const { gh, source } = setup({}, { knownKeys: (keys) => new Set(keys.filter((k) => k.endsWith('/1'))) });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    const items = await source.discover();
    expect(items.map((i) => i.number)).toEqual([1]);
    expect(source.intake?.().map((o) => [o.key, o.reason, o.action])).toEqual([
      [`https://github.com/${REPO}/issues/1`, undefined, undefined],
      [`https://github.com/${REPO}/issues/2`, 'claimed by another hopper (no holder recorded)', 'release'],
    ]);
  });

  it('a claimed issue whose job may be re-run is returned, with its comments loaded for the new job', async () => {
    const all = (keys: string[]) => new Set(keys);
    const { gh, source } = setup({}, { knownKeys: all, rerunnable: all });
    const issue = gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.addComment(REPO, issue.number, 'owner', 'try again');
    const [item] = await source.discover();
    expect(item!.prompt).toContain('try again');
    expect(source.intake?.()[0]?.reason).toBeUndefined();
  });

  it('a claimed issue with a live job does not have its comments loaded', async () => {
    const { gh, source } = setup({}, { knownKeys: (keys) => new Set(keys) });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    await source.discover();
    expect(gh.calls.some((c) => c.method === 'listComments')).toBe(false);
  });

  it('without knownKeys every claimed issue is skipped (never re-run blind)', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.()[0]?.reason).toBe('claimed: whether a job here holds it is not known');
  });

  it.each([[''], ['  \n\t ']])('an empty issue body (%j) is an invalid item, still offered so it is claimed then failed', async (body) => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, body, labels: ['hopper'] });
    expect((await discoverOne(source)).invalid).toBe('empty issue body');
  });

  it('one repo failing does not hide the others; the error is shown in status', async () => {
    const { gh, source } = setup({ repos: ['owner/gone', REPO] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.failNext('listOpenIssues', new GitHubApiError('gh: Not Found (HTTP 404)', true, 404));
    expect((await source.discover()).map((i) => i.repo)).toEqual([REPO]);
    expect(source.describe().repoErrors).toEqual({ 'owner/gone': 'gh: Not Found (HTTP 404)' });
  });

  it('when every repo fails, discover rejects (the sync shows the error)', async () => {
    const { gh, source } = setup();
    gh.failNext('listOpenIssues', new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    await expect(source.discover()).rejects.toThrow('Bad Gateway');
  });

  it('describe reports the configured scope', () => {
    const { source } = setup();
    expect(source.describe()).toMatchObject({ repos: [REPO], assignee: 'owner', label: 'hopper', projectErrors: {} });
    expect(source.describe()).not.toHaveProperty('authors');
    expect(source.name).toBe('github');
    expect(source.kind).toBe('github-account');
  });
});
