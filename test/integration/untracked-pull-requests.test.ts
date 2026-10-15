// Untracked pull requests (issue #1176), over the real daemon: after a sync, the source's status lists every open pull
// request of its job repositories that no job names and the ledger does not hold, each with why, and the Pull requests list
// answers them too; a job's own pull request is not listed. Take into Intake gives the issue of one not in Intake the label
// and the connected account, and the next sync lists it in Intake. In-memory fake GitHub at the GitHubApi seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { UntrackedPullRequest } from '../../src/domain/untracked-pull-requests.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
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

  it('Take into Intake: the issue gets the label and the account, and Intake lists it as a request card', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nA labelled one.`, labels: ['hopper'], assignees: ['someone-else'] });
    const unlabelled = gh.createIssue({ repo: REPO, body: 'No label.' });
    gh.openPullRequest(REPO, unlabelled.number, { createdAt: new Date().toISOString() });
    await app.sync();
    const listed = await waitFor(async () => (await untracked(app))?.find((u) => u.offer === 'take_in'), { what: 'an issue to take in' });
    const view = (await app.api<{ untracked?: UntrackedPullRequest[] }>('GET', '/api/pull-requests')).body;
    expect(view.untracked?.[0]?.source).toBe('github');
    const token = await app.login();
    const r = await app.ui('/ui/api/sources/github/intake', { kind: 'take_in', keys: [listed.issue!.url] }, { token });
    expect(r).toEqual({ status: 200, body: { done: [listed.issue!.url], failed: {} } });
    expect(gh.issue(REPO, unlabelled.number).labels).toContain('hopper');
    expect(gh.issue(REPO, unlabelled.number).assignees).toEqual(['owner']);
    // The intake action synced at once: the issue is a request card in Intake (the hopper's app added the label), so the
    // pull request's issue is in Intake now, and no job of it made it yet.
    const src = (await app.api<{ sources: { name: string; detail?: { intake?: { key: string; group?: string }[] } }[] }>('GET', '/api/sources')).body.sources[0]!;
    expect(src.detail?.intake?.find((x) => x.key === listed.issue!.url)?.group).toBe('request');
    expect((await untracked(app))?.find((u) => u.url === listed.url)?.reason).toBe('not_by_a_job');
  });

  it('Take into Intake whose GitHub write fails: its Pull requests row says why, and offers it again (issue #1194)', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const unlabelled = gh.createIssue({ repo: REPO, body: 'No label.' });
    gh.openPullRequest(REPO, unlabelled.number, { createdAt: new Date().toISOString() });
    await app.sync();
    const listed = await waitFor(async () => (await untracked(app))?.find((u) => u.offer === 'take_in'), { what: 'an issue to take in' });
    // Refused for good: a write GitHub refused for now is tried again (part 8).
    gh.failNext('addLabels', new GitHubApiError('label refused', true, 422));
    const token = await app.login();
    const r = await app.ui('/ui/api/sources/github/intake', { kind: 'take_in', keys: [listed.issue!.url] }, { token });
    expect(r.status).toBe(200);
    const row = await waitFor(async () => {
      const v = (await app.api<{ untracked?: UntrackedPullRequest[] }>('GET', '/api/pull-requests')).body;
      const u = v.untracked?.find((x) => x.url === listed.url);
      return u?.writeBehind?.state === 'failed' ? u : undefined;
    }, { what: 'the write-behind failed on its row' });
    expect(row).toMatchObject({ offer: 'take_in', writeBehind: { act: 'take_in', state: 'failed', error: expect.stringContaining('label refused') } });
  });
});
