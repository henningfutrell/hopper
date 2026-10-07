import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubApiError, createGhCliApi } from '../../src/sources/github/index.ts';

const BIN = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
chmodSync(BIN, 0o755);

let dir: string;
const saved = { ...process.env };

function calls(): { argv: string[]; stdin: string | null; mark: string | null }[] {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-gh-cli-'));
  process.env.FAKE_GH_DIR = dir;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const gh = (timeoutMs?: number) => createGhCliApi({ bin: BIN, ...(timeoutMs ? { timeoutMs } : {}) });

async function rejection(p: Promise<unknown>): Promise<GitHubApiError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(GitHubApiError);
  return err as GitHubApiError;
}

describe('gh CLI GitHubApi', () => {
  it('whoami asks gh for the login and trims it', async () => {
    expect(await gh().whoami()).toBe('owner');
    expect(calls()[0]!.argv).toEqual(['api', 'user', '--jq', '.login']);
  });

  it('passes the environment through (gh keyring auth)', async () => {
    process.env.FAKE_GH_MARK = 'kept';
    await gh().whoami();
    expect(calls()[0]!.mark).toBe('kept');
  });

  it('searchOpenIssues searches open labelled issues over every owner and maps them', async () => {
    const issues = await gh().searchOpenIssues({ owners: ['o', 'p'], label: 'hopper' });
    expect(calls()[0]!.argv).toEqual([
      'search', 'issues', '--owner', 'o', '--owner', 'p', '--label', 'hopper', '--state', 'open',
      '--json', 'url,number,title,body,author,labels,repository,updatedAt,state', '--limit', '200',
    ]);
    expect(issues[0]).toEqual({
      repo: 'o/r', number: 1, url: 'https://github.com/o/r/issues/1', title: 'Issue 1', body: 'body 1',
      author: 'owner', labels: ['hopper'], state: 'open', updatedAt: '2026-10-02T09:00:00Z',
    });
    expect(issues[1]).toMatchObject({ repo: 'p/q', body: '', labels: [] });
  });

  it('listOpenIssues lists one repo and fills in the repo itself', async () => {
    const issues = await gh().listOpenIssues('h/sandbox', 'hopper');
    expect(calls()[0]!.argv).toEqual([
      'issue', 'list', '-R', 'h/sandbox', '--label', 'hopper', '--state', 'open',
      '--json', 'url,number,title,body,author,labels,updatedAt,state', '--limit', '200',
    ]);
    expect(issues).toEqual([expect.objectContaining({ repo: 'h/sandbox', number: 3, author: 'owner', labels: ['hopper'], state: 'open' })]);
  });

  it('getIssue reads the REST issue: state, labels, author, null body as empty, closedBy, closedAt, stateReason', async () => {
    expect(await gh().getIssue('o/r', 5)).toEqual({
      repo: 'o/r', number: 5, url: 'https://github.com/o/r/issues/5', title: 'T', body: '', author: 'owner',
      labels: ['hopper', 'hopper:claimed'], state: 'closed', updatedAt: '2026-10-02T09:30:00Z', closedBy: 'someone',
      closedAt: '2026-10-02T09:30:00Z', stateReason: 'completed',
    });
    expect(calls()[0]!.argv).toEqual(['api', 'repos/o/r/issues/5']);
  });

  it.each([[404], [410]])('HTTP %i is a permanent error with its status', async (status) => {
    const err = await rejection(gh().getIssue('o/r', status));
    expect(err.permanent).toBe(true);
    expect(err.status).toBe(status);
  });

  it('a 5xx is transient', async () => {
    const err = await rejection(gh().getIssue('o/r', 502));
    expect(err).toMatchObject({ permanent: false, status: 502 });
  });

  it('a rate-limit 403 is transient', async () => {
    const err = await rejection(gh().getIssue('o/r', 429));
    expect(err.permanent).toBe(false);
  });

  it('output that is not JSON is a transient error', async () => {
    const err = await rejection(gh().getIssue('o/r', 7));
    expect(err.permanent).toBe(false);
    expect(err.message).toMatch(/JSON/);
  });

  it('a timeout is transient', async () => {
    const err = await rejection(gh(300).getIssue('o/r', 999));
    expect(err.permanent).toBe(false);
    expect(err.message).toMatch(/timed out/);
  });

  it('listComments reads every page (paginate + slurp) and flattens them with numeric ids', async () => {
    const comments = await gh().listComments('o/r', 5);
    expect(calls()[0]!.argv).toEqual(['api', '--paginate', '--slurp', 'repos/o/r/issues/5/comments?per_page=100']);
    expect(comments.map((c) => [c.id, c.author, c.body])).toEqual([[11, 'owner', 'first'], [12, 'other', 'second'], [13, 'owner', 'third']]);
    expect(comments[0]).toMatchObject({ createdAt: '2026-10-02T09:00:01Z', url: 'https://github.com/o/r/issues/5#issuecomment-11' });
  });

  it('ensureLabel creates or updates the label idempotently (--force)', async () => {
    await gh().ensureLabel('o/r', 'hopper:done', '0e8a16', 'hopper finished this');
    expect(calls()[0]!.argv).toEqual(['label', 'create', 'hopper:done', '-R', 'o/r', '--color', '0e8a16', '--description', 'hopper finished this', '--force']);
  });

  it('addLabels / removeLabels edit the issue', async () => {
    await gh().addLabels('o/r', 5, ['hopper:done']);
    await gh().removeLabels('o/r', 5, ['hopper:claimed', 'x']);
    expect(calls().map((c) => c.argv)).toEqual([
      ['issue', 'edit', '5', '-R', 'o/r', '--add-label', 'hopper:done'],
      ['issue', 'edit', '5', '-R', 'o/r', '--remove-label', 'hopper:claimed,x'],
    ]);
  });

  it('closingPullRequest asks GraphQL for the last close event and returns its pull request', async () => {
    expect(await gh().closingPullRequest('o/r', 5)).toEqual({
      url: 'https://github.com/o/r/pull/9', createdAt: '2026-10-02T09:10:00Z', mergedAt: '2026-10-02T09:20:00Z',
    });
    const argv = calls()[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(argv).toEqual(expect.arrayContaining(['-F', 'owner=o', '-F', 'name=r', '-F', 'number=5']));
    expect(argv[argv.indexOf('-f') + 1]).toMatch(/^query=.*CLOSED_EVENT/s);
  });

  it('closingPullRequest is undefined when a person or a commit closed the issue', async () => {
    expect(await gh().closingPullRequest('o/r', 6)).toBeUndefined();
    expect(await gh().closingPullRequest('o/r', 8)).toBeUndefined();
  });

  it('openClosingPullRequests asks GraphQL for the open pull requests that close the issue on merge (issue #187)', async () => {
    expect(await gh().openClosingPullRequests('o/r', 5)).toEqual([
      { url: 'https://github.com/o/r/pull/10', createdAt: '2026-10-02T09:30:00Z', isDraft: false },
      { url: 'https://github.com/o/r/pull/11', createdAt: '2026-10-02T09:40:00Z', isDraft: true },
    ]);
    const argv = calls()[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(argv).toEqual(expect.arrayContaining(['-F', 'owner=o', '-F', 'name=r', '-F', 'number=5']));
    expect(argv[argv.indexOf('-f') + 1]).toMatch(/^query=.*closedByPullRequestsReferences/s);
    expect(await gh().openClosingPullRequests('o/r', 6)).toEqual([]);
  });

  it('projectItems lists up to 1000 open issue items and maps url, index and fields', async () => {
    const items = await gh().projectItems('o', 3);
    expect(calls()[0]!.argv).toEqual(['project', 'item-list', '3', '--owner', 'o', '--format', 'json', '--limit', '1000', '--query', 'is:issue is:open']);
    expect(items).toEqual([
      { url: 'https://github.com/o/r/issues/5', index: 0, fields: { priority: 'P1', status: 'Todo', 'story points': 3 } },
      { url: 'https://github.com/o/r/issues/6', index: 2, fields: {} },
    ]);
  });

  it('projectItems without the read:project scope fails permanently and says which scope', async () => {
    const err = await rejection(gh().projectItems('o', 9));
    expect(err.permanent).toBe(true);
    expect(err.message).toContain('read:project');
  });

  it('a missing gh binary is reported as an error, not a crash', async () => {
    const err = await rejection(createGhCliApi({ bin: join(dir, 'no-such-gh') }).whoami());
    expect(err.message).toMatch(/no-such-gh/);
  });
});
