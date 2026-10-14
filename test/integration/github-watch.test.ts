// Issue #427 (tracking issue #424, job 3): GitHub watches. Each pointed job that has not ended has a watch that polls its
// item on GitHub on an interval, compares it with the last snapshot, and records an event only on a change. The
// interval is a setting in the database, changed in the UI, applied without a restart. The daemon, store and HTTP edge
// are real; GitHub is a fake on loopback (test/support/fake-forges.ts), read with the person's own GitHub connection.
//
// Feature: GitHub watches
//   Scenario: a label, a comment or a state change on a watched issue is exactly one event within one interval
//     Given a connected GitHub account, an open issue, and a pointed job on it
//     Then the watch takes its first snapshot at once, and records no event
//     When a label is added to the issue on GitHub
//     Then within one interval there is exactly one github_watch.changed, naming the label
//     When a person comments and the issue is closed as completed, and a pull request references it
//     Then the next poll records one more event with the comment, the state and the linked pull request
//   Scenario: no change produces no event
//     Given a watched issue that does not change
//     When its watch polls again and again
//     Then each poll is recorded on the watch, and no event
//   Scenario: changing the interval in the UI applies without a restart
//     When an admin changes the interval
//     Then it is saved, github_watch.settings_changed is in the log, and the watches poll at once on it
//     And a restart keeps it; a value out of range is refused
//   Scenario: an ended pointed job is no longer watched
//     When the pointed job is abandoned
//     Then its watch stops: a change on GitHub records nothing
//   Scenario: with no GitHub connection the watch says why
//     Then the watch shows the problem, and records no event
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, DEFAULT_GITHUB_WATCH, type DomainEvent, type GitHubWatch, type GitHubWatchView, type PointedJob } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'octo/app';

async function boot(github: FakeForge, dbPath: string, o: { connected?: boolean } = {}) {
  const app = await startTestApp({
    dbPath, env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (o.connected !== false) connectGitHub(app, [REPO]);
  return { app, token: await app.login() };
}

async function start(o: { connected?: boolean } = {}) {
  const github = await createFakeGitHub({
    clientId: 'gh-client-id', issues: [{ repo: REPO, number: 1, title: 'Greet', body: 'Say hello', author: 'owner', labels: ['bug'] }],
  });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return { github, dbPath: db.dbPath, ...(await boot(github, db.dbPath, o)) };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const view = async (a: TestApp) => (await a.api<GitHubWatchView>('GET', '/api/github-watches')).body;
const watchOf = async (a: TestApp, id: string): Promise<GitHubWatch | undefined> => (await view(a)).watches.find((w) => w.pointedJob === id);
const interval = (a: TestApp, token: string, intervalSeconds: number) => a.ui<GitHubWatchView>('/ui/api/github-watches', { intervalSeconds }, { token });
const issue = (g: FakeForge) => g.issues.find((i) => i.repo === REPO && i.number === 1)!;

async function pointAt(app: TestApp, token: string): Promise<PointedJob> {
  const r = await app.ui<PointedJob>('/ui/api/pointed-jobs', { repo: REPO, pointer: { kind: 'issue', number: 1, url: `https://github.com/${REPO}/issues/1` }, directive: 'Greet' }, { token });
  expect(r.status).toBe(200);
  return r.body;
}

/** The watch once it polled after `after` (an ISO time), or its first poll. */
async function polled(app: TestApp, id: string, after = ''): Promise<GitHubWatch> {
  let w: GitHubWatch | undefined;
  await expect.poll(async () => { w = await watchOf(app, id); return (w?.polledAt ?? '') > after || (w?.error !== undefined && after === ''); }, { timeout: 10_000 }).toBe(true);
  return w!;
}

/** A poll now: a change of the interval applies at once, and the watches poll on it. */
async function pollNow(app: TestApp, token: string, id: string, seconds: number): Promise<GitHubWatch> {
  const before = (await watchOf(app, id))?.polledAt ?? '';
  expect((await interval(app, token, seconds)).status).toBe(200);
  return polled(app, id, before);
}

describe('GitHub watches', () => {
  it('records a label, a comment or a state change as exactly one event within one interval', { timeout: 40_000 }, async () => {
    const { app, token, github } = await start();
    expect((await interval(app, token, 10)).status).toBe(200);
    const job = await pointAt(app, token);

    const first = await polled(app, job.id);
    expect(first.snapshot).toMatchObject({ state: 'open', labels: ['bug'], comments: [], linkedPullRequests: [] });
    expect(eventsOf(app, 'github_watch.changed')).toEqual([]);

    // A label on GitHub: the next round, at most one interval (10 s) away, sees it — once.
    issue(github).labels.push('ready');
    await expect.poll(() => eventsOf(app, 'github_watch.changed').length, { timeout: 12_000, interval: 200 }).toBe(1);
    expect(eventsOf(app, 'github_watch.changed')[0]!.data).toEqual({
      pointedJob: job.id, repo: REPO, pointer: job.pointer, changes: { labels: { added: ['ready'], removed: [] } },
    });
    await pollNow(app, token, job.id, 11);
    expect(eventsOf(app, 'github_watch.changed')).toHaveLength(1);

    // A comment, the close and a referencing pull request at once: one more event, with every change.
    issue(github).comments = [{ id: 501, body: 'Done?', user: { login: 'maintainer' }, created_at: '2026-10-11T12:00:00Z' }];
    Object.assign(issue(github), { state: 'closed', stateReason: 'completed' });
    github.timelines = { [`${REPO}#1`]: [{ event: 'cross-referenced', source: { issue: { html_url: `https://github.com/${REPO}/pull/2`, pull_request: {} } } }] };
    await pollNow(app, token, job.id, 12);
    const changed = eventsOf(app, 'github_watch.changed');
    expect(changed).toHaveLength(2);
    expect(changed[0]!.data.changes).toEqual({
      state: { from: 'open', to: 'closed', reason: 'completed' },
      comments: { added: [{ id: 501, author: 'maintainer', at: '2026-10-11T12:00:00Z' }], removed: 0 },
      linkedPullRequests: { added: [`https://github.com/${REPO}/pull/2`], removed: [] },
    });
    // Never a comment's text.
    expect(JSON.stringify(changed[0]!.data)).not.toContain('Done?');
  });

  it('records no event when nothing changed', async () => {
    const { app, token } = await start();
    const job = await pointAt(app, token);
    const first = await polled(app, job.id);
    const again = await pollNow(app, token, job.id, 30);
    const third = await pollNow(app, token, job.id, 31);
    expect(third.polledAt! > again.polledAt! && again.polledAt! > first.polledAt!).toBe(true);
    expect(third.changedAt).toBe(first.changedAt);
    expect(eventsOf(app, 'github_watch.changed')).toEqual([]);
  });

  it('applies a new interval from the UI at once, and keeps it after a restart', async () => {
    const { app, token, github, dbPath } = await start();
    expect((await view(app)).settings).toEqual(DEFAULT_GITHUB_WATCH);
    const job = await pointAt(app, token);
    await polled(app, job.id);

    const r = await interval(app, token, 300);
    expect(r.body.settings).toEqual({ intervalSeconds: 300 });
    expect(eventsOf(app, 'github_watch.settings_changed').map((e) => e.data)).toEqual([{ from: { intervalSeconds: 60 }, to: { intervalSeconds: 300 }, by: expect.any(String) }]);
    // The same value: nothing changed, nothing recorded.
    await interval(app, token, 300);
    expect(eventsOf(app, 'github_watch.settings_changed')).toHaveLength(1);
    expect((await interval(app, token, 5)).status).toBe(400);

    await app.stop();
    apps.splice(0);
    const { app: again } = await boot(github, dbPath);
    expect((await view(again)).settings).toEqual({ intervalSeconds: 300 });
  });

  it('stops watching a pointed job once it ended', async () => {
    const { app, token, github } = await start();
    const job = await pointAt(app, token);
    await polled(app, job.id);
    expect((await app.ui(`/ui/api/pointed-jobs/${job.id}/transition`, { to: 'abandoned' }, { token })).status).toBe(200);
    expect((await view(app)).watches).toEqual([]);

    issue(github).labels.push('ready');
    const before = github.requests.length;
    await interval(app, token, 20);
    await new Promise((r) => setTimeout(r, 300));
    expect(github.requests.slice(before).some((q) => q.path.includes('/issues/1'))).toBe(false);
    expect(eventsOf(app, 'github_watch.changed')).toEqual([]);
  });

  it('shows why a watch cannot poll when GitHub is not connected', async () => {
    const { app, token } = await start({ connected: false });
    const job = await pointAt(app, token);
    const w = await polled(app, job.id);
    expect(w.error).toMatch(/not connected/);
    expect(w.snapshot).toBeUndefined();
    expect(eventsOf(app, 'github_watch.changed')).toEqual([]);
  });
});
