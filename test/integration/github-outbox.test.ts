// The GitHub outbox (issue #1238), over the real daemon and its store: an intake action's GitHub writes are rows the
// outbox sends after the answer. A restart sends the rows a stopped hopper left. With GitHub's writes never answering,
// the actions answer and a sync completes. An intake action asks for no full sync: only the repository the outbox wrote
// to is listed again. In-memory fake GitHub at the GitHubApi seam, its writes held by a gate where a test says so.
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubApi } from '../../src/sources/github/api.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OTHER = 'owner/other-sandbox';
const WRITES = new Set(['addAssignees', 'addLabels', 'removeLabels']);
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

/** The fake, its writes never answered: each write sent is counted, none reaches it. */
function neverWrites(gh: FakeGitHub): { api: GitHubApi; sent: string[] } {
  const sent: string[] = [];
  const api = new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function' || !WRITES.has(String(prop))) return v;
      return () => { sent.push(String(prop)); return new Promise<never>(() => {}); };
    },
  });
  return { api, sent };
}

async function boot(dbPath: string, github: GitHubApi, repos = [REPO]): Promise<TestApp> {
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath, env: {}, seams: { github }, plugins });
  apps.push(a);
  connectGitHub(a, repos);
  return a;
}

type Detail = { intake?: { key: string; action?: string; writeBehind?: { state: string } }[]; writeBehindPending?: number; writeBehindErrors?: Record<string, string> };
const detail = async (app: TestApp): Promise<Detail> =>
  (await app.api<{ sources: { name: string; detail?: Detail }[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github')?.detail ?? {};

describe('the GitHub outbox (issue #1238)', () => {
  it('a restart with rows not sent sends them after the start', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const held = neverWrites(gh);
    const first = await boot(db.dbPath, held.api);
    await first.sync();
    const token = await first.login();
    expect(await first.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [issue.url] }, { token })).toEqual({ status: 200, body: { done: [issue.url], failed: {} } });
    await waitFor(() => held.sent.includes('addAssignees'), { what: 'the assignment sent' });
    expect(await detail(first)).toMatchObject({ writeBehindPending: 1 });
    await first.stop();
    apps.splice(0);
    expect(gh.issue(REPO, issue.number).assignees).toEqual([]);

    const second = await boot(db.dbPath, gh);
    await waitFor(() => gh.issue(REPO, issue.number).assignees.includes('owner'), { what: 'the assignment after the restart' });
    await waitFor(async () => (await detail(second)).writeBehindPending === undefined, { what: 'no row left' });
    expect(second.user().store.events.recent(10, ['source.issues_assigned']).map((e) => e.data.keys)).toEqual([[issue.url]]);
  });

  it('with GitHub\'s writes never answering, the actions answer and a sync completes', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const assign = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const claimed = gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', 'hopper:held-by:0f0f0f0f0f0f'] });
    const backburner = gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    const held = neverWrites(gh);
    const app = await boot(db.dbPath, held.api);
    await app.sync();
    const token = await app.login();
    for (const [kind, url] of [['assign', assign.url], ['release', claimed.url], ['unbackburner', backburner.url]] as const) {
      expect(await app.ui('/ui/api/sources/github/intake', { kind, keys: [url] }, { token })).toEqual({ status: 200, body: { done: [url], failed: {} } });
    }
    // The first write never ends, so the outbox sends nothing more meanwhile; the sync does not wait for it.
    await waitFor(() => held.sent.length > 0, { what: 'a write sent' });
    await app.sync();
    const d = await detail(app);
    expect(d).toMatchObject({ writeBehindPending: 3 });
    expect(d.writeBehindErrors).toBeUndefined();
    expect(d.intake?.filter((x) => x.writeBehind?.state === 'running').map((x) => x.key).sort()).toEqual([assign.url, claimed.url, backburner.url].sort());
  });

  it('an intake action asks for no full sync: only the repository the outbox wrote to is listed again', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'], body: `${JSON.stringify({ op: 'echo' })}\n\nDo it.` });
    gh.createIssue({ repo: OTHER, assignees: [], labels: ['hopper'] });
    const app = await boot(db.dbPath, gh, [REPO, OTHER]);
    await app.sync();
    const listedBefore = gh.calls.length;
    const token = await app.login();
    expect((await app.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [issue.url] }, { token })).status).toBe(200);
    // The outbox sends the assignment, the repository it wrote to is due, and the sync after it takes the issue.
    await waitFor(async () => (await detail(app)).intake?.find((x) => x.key === issue.url && x.action === undefined && x.writeBehind === undefined), { what: 'the issue taken' });
    const listings = gh.calls.slice(listedBefore).filter((c) => c.method === 'listRepos').map((c) => c.args[0]);
    expect(listings).toEqual([[REPO]]);
  });
});
