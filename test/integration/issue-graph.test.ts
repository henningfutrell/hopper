// The issue graph (issue #437) end to end: each issue the connected account's source lists is kept in the user's store
// with its repository, owner, Projects and linked issues and pull requests; it stays current as the issue changes; its
// setting is edited in the UI and applies at once; and nothing depends on it. Real daemon and database, in-memory fake
// GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginsReport } from '../../src/domain/plugins.ts';
import type { SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub, githubSource } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const ISSUE = `https://github.com/${REPO}/issues/1`;
const PROJECT = 'https://github.com/orgs/owner/projects/4';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, options: Record<string, unknown> = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [githubSource({ executor: 'scripted', ...options })] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const graphOf = (a: TestApp) => a.user().store.issueGraph;
const edges = (a: TestApp) => graphOf(a).edges().map((e) => `${e.from} ${e.kind} ${e.to}`);
const places = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'issuePlace').length;
const refreshes = (gh: FakeGitHub) => gh.calls.filter((c) => c.method === 'graphStates');

/** Issue 1, labelled for the hopper, an item of Project 4, a sub-issue of issue 2, with a closing and a mentioning pull request. */
function seed(gh: FakeGitHub) {
  gh.createIssue({ repo: REPO, title: 'Watched', labels: ['hopper'], parent: 2 });
  gh.createIssue({ repo: REPO, title: 'The whole' });
  gh.setProjectItems('owner', 4, [{ url: ISSUE }]);
  const closing = gh.openPullRequest(REPO, 1, { createdAt: '2026-10-02T10:00:00.000Z' });
  const mentioning = gh.openReferencingPullRequest(REPO, 1, { createdAt: '2026-10-02T10:00:00.000Z' });
  return { closing: closing.url, mentioning: mentioning.url };
}

describe('the issue graph', () => {
  it('keeps each listed issue with its repository, owner, Projects and linked issues and pull requests', async () => {
    const gh = createFakeGitHub();
    const prs = seed(gh);
    const a = await boot(gh);
    await a.sync();

    expect(graphOf(a).node(ISSUE)).toMatchObject({ kind: 'issue', attrs: { repo: REPO, number: 1, title: 'Watched', state: 'open' } });
    expect(graphOf(a).nodes().map((n) => `${n.kind} ${n.id}`).sort()).toEqual([
      `issue ${ISSUE}`, `issue https://github.com/${REPO}/issues/2`, 'owner owner:owner', `project ${PROJECT}`,
      `pull_request ${prs.closing}`, `pull_request ${prs.mentioning}`, `repo repo:${REPO}`,
    ].sort());
    expect(edges(a)).toEqual(expect.arrayContaining([
      `${ISSUE} in_repo repo:${REPO}`, `repo:${REPO} owned_by owner:owner`, `${ISSUE} in_project ${PROJECT}`, `${PROJECT} owned_by owner:owner`,
      `${prs.closing} closes ${ISSUE}`, `${prs.mentioning} references ${ISSUE}`, `${ISSUE} sub_issue_of https://github.com/${REPO}/issues/2`,
    ]));
    expect(edges(a)).not.toContain(`${prs.mentioning} closes ${ISSUE}`);
  });

  it('stays current: a changed issue is read again at the next sync; an unchanged one waits for its refresh', async () => {
    const gh = createFakeGitHub();
    const prs = seed(gh);
    const a = await boot(gh);
    await a.sync();
    await a.sync(); // the claim moved the issue's updatedAt: read once again
    const settled = places(gh);
    await a.sync();
    expect(places(gh)).toBe(settled);

    gh.setProjectItems('owner', 4, []);
    gh.closePullRequest(prs.closing);
    const another = gh.openReferencingPullRequest(REPO, 1, { createdAt: '2026-10-02T11:00:00.000Z' });
    gh.editIssue(REPO, 1, { title: 'Watched, renamed' }, 'owner', '2099-01-01T00:00:00.000Z');
    await a.sync();

    expect(places(gh)).toBe(settled + 1);
    expect(graphOf(a).node(ISSUE)!.attrs.title).toBe('Watched, renamed');
    expect(edges(a)).not.toContain(`${ISSUE} in_project ${PROJECT}`);
    expect(edges(a)).toContain(`${another.url} references ${ISSUE}`);
    expect(graphOf(a).node(prs.closing)!.attrs.state).toBe('closed');
  });

  it('its settings are edited in the UI and apply without a restart: 0 minutes reads at every sync, off keeps no graph', async () => {
    const gh = createFakeGitHub();
    seed(gh);
    const a = await boot(gh);
    const token = await a.login();
    const edit = async (issueGraph: boolean, graphRefreshMinutes: number) => {
      const { version } = (await a.api<PluginsReport>('GET', '/api/plugins')).body.config;
      const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'job-source', name: 'github', options: { pollSeconds: 3600, executor: 'scripted', issueGraph, graphRefreshMinutes }, version }, { token });
      expect(r.status).toBe(200);
    };
    await edit(true, 0);
    const before = places(gh);
    await a.sync();
    await a.sync();
    expect(places(gh)).toBe(before + 2);

    await edit(false, 0);
    const off = places(gh);
    await a.sync();
    expect(places(gh)).toBe(off);
  });

  it('nothing depends on it: a read that fails is only said in the source status, and the issue still becomes a job', async () => {
    const gh = createFakeGitHub();
    seed(gh);
    gh.failNext('issuePlace', new GitHubApiError('place of the issue: GitHub is down', false));
    const a = await boot(gh);
    await a.sync();

    expect((await a.api('GET', '/api/jobs')).body.jobs.map((j: { source?: { key: string } }) => j.source?.key)).toContain(ISSUE);
    const { sources } = (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body;
    expect(sources.find((s) => s.name === 'github')?.detail).toMatchObject({ graphErrors: { [ISSUE]: 'place of the issue: GitHub is down' } });
    expect(graphOf(a).node(ISSUE)).toBeUndefined();

    await a.sync();
    expect(graphOf(a).node(ISSUE)).toBeDefined();
  });

  it('the graph refresh: each refresh interval, the items it shows not done are read again in one batched read (issue #1036)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const gh = createFakeGitHub();
    const prs = seed(gh);
    const a = await boot(gh);
    await a.sync();
    const first = refreshes(gh).length;
    expect(first).toBe(1);

    // The watched issue closes, so no read of its place tells the graph what became of the items it links.
    gh.closeIssue(REPO, 1);
    gh.closeIssue(REPO, 2);
    gh.mergePullRequest(prs.mentioning);
    gh.closePullRequest(prs.closing);
    await a.sync();
    expect(refreshes(gh)).toHaveLength(first);
    expect(graphOf(a).node(`https://github.com/${REPO}/issues/2`)!.attrs.state).toBe('open');

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await a.sync();
    expect(refreshes(gh)).toHaveLength(first + 1);
    expect(graphOf(a).node(`https://github.com/${REPO}/issues/2`)!.attrs).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(graphOf(a).node(ISSUE)!.attrs).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(graphOf(a).node(prs.mentioning)!.attrs.state).toBe('merged');
    expect(graphOf(a).node(prs.closing)!.attrs.state).toBe('closed');

    // Nothing the graph shows is open now: no read at the next refresh.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await a.sync();
    expect(refreshes(gh)).toHaveLength(first + 1);
  });
});
