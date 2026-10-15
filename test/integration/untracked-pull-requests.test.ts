// Untracked pull requests (issue #1176), over the real daemon: after a sync, the source's status lists every open pull
// request of its job repositories that no job names and the ledger does not hold, each with why, and the Pull requests list
// answers them too; a job's own pull request is not listed. In-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { UntrackedPullRequest } from '../../src/domain/untracked-pull-requests.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

const untracked = async (app: TestApp): Promise<UntrackedPullRequest[] | undefined> =>
  ((await app.api<{ sources: { name: string; detail?: { untrackedPullRequests?: UntrackedPullRequest[] } }[] }>('GET', '/api/sources')).body
    .sources.find((s) => s.name === 'github')?.detail?.untrackedPullRequests);

describe('untracked pull requests (issue #1176)', () => {
  it('each open pull request no job names is listed with why; the job\'s own is not', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] });
    let own: string | undefined;
    app.scripted.ships((j) => { own ??= gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString() }).url; });
    await app.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    const unlabelled = gh.createIssue({ repo: REPO, body: 'No label.' });
    const closesUnlabelled = gh.openPullRequest(REPO, unlabelled.number, { createdAt: new Date().toISOString() });
    const none = gh.openUnlinkedPullRequest(REPO, { createdAt: new Date().toISOString(), headRef: 'chore' });
    await app.sync();
    const listed = await waitFor(async () => untracked(app), { what: 'the untracked pull requests' });
    expect(listed.map((u) => [u.url, u.reason])).toEqual([
      [closesUnlabelled.url, 'issue_not_in_intake'],
      [none.url, 'no_issue'],
    ]);
    expect(listed.map((u) => u.url)).not.toContain(own);
    // The Pull requests list says the same.
    const view = (await app.api<{ untracked?: UntrackedPullRequest[] }>('GET', '/api/pull-requests')).body;
    expect(view.untracked?.map((u) => u.reason)).toEqual(['issue_not_in_intake', 'no_issue']);
  });
});
