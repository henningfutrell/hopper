// New repositories (issue #2795, design.md "New repositories"), through the real daemon, store and HTTP edge; GitHub is a
// fake on loopback (test/support/fake-forges.ts), whose personal access token reaches every repository its issues are in.
//
// Feature: a repository the connected account reaches anew
//   Scenario: by default it waits as a new-repository ask in Sources; Dismiss drops the ask, and it is not asked again
//   Scenario: with the owner's mode `accept`, it becomes a job repository at once, and its issues become jobs
//   Scenario: each ask and each add by the policy is an event, so the notifiers tell the person (part 2)
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus, DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const SLEEP = '{"op":"sleep","ms":60000}';
const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

type Connected = Extract<ConnectedAccountStatus, { state: 'connected' }>;

async function setup() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', issues: [{ repo: 'acme/api', number: 1, title: 'Old work', body: SLEEP, author: 'ada', labels: ['hopper'] }] });
  cleanups.push(() => github.close());
  github.tokens.set('github_pat_ada', 'ada');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    plugins: { jobSources: [{ name: 'github-account', plugin: 'github-account', options: { executor: 'scripted' } }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id' },
  });
  apps.push(app);
  const token = await app.login();
  const post = async (body: Record<string, unknown>) => (await app.ui<Connected>('/ui/api/connected-accounts', { provider: 'github', ...body }, { token })).body;
  const account = async () => (await app.api<{ accounts: Connected[] }>('GET', '/api/connected-accounts')).body.accounts[0]!;
  /** Reads what the token reaches again, and waits until the read ended. */
  const read = async () => {
    await app.ui('/ui/api/connected-accounts/refresh', { provider: 'github' }, { token });
    return waitFor(async () => { const a = await account(); return a.installationsReading ? undefined : a; }, { what: 'the read to end' });
  };
  expect((await post({ action: 'connect-token', token: 'github_pat_ada' })).state).toBe('connected');
  await waitFor(async () => (await account()).installationsCheckedAt, { what: 'the first read' });
  await post({ action: 'choose', repositories: ['acme/api'] });
  return { app, github, post, read };
}

const jobs = async (app: TestApp) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const newRepositoryEvents = async (app: TestApp) => (await app.api<{ events: DomainEvent[] }>('GET', '/api/events?limit=1000')).body.events
  .filter((e) => e.type.startsWith('connected_account.new_repositories_')).map((e) => ({ type: e.type, data: e.data }));

describe('new repositories', () => {
  it('asks by default: the ask waits in Sources until a person adds or dismisses it', async () => {
    const { app, github, post, read } = await setup();
    expect((await read()).newRepositories).toEqual({ policy: { mode: 'ask', owners: {} }, asks: [] });

    github.issues.push({ repo: 'acme/web', number: 2, title: 'New work', body: SLEEP, author: 'ada', labels: ['hopper'] });
    const asked = await read();
    expect(asked.jobRepositories).toEqual(['acme/api']);
    expect(asked.newRepositories?.asks.map((a) => a.repository)).toEqual(['acme/web']);
    expect(await newRepositoryEvents(app)).toEqual([{ type: 'connected_account.new_repositories_asked', data: { provider: 'github', account: 'ada', repositories: ['acme/web'] } }]);

    const dismissed = await post({ action: 'new-repositories', dismiss: ['acme/web'] });
    expect(dismissed.newRepositories?.asks).toEqual([]);
    expect((await read()).newRepositories?.asks).toEqual([]);
    expect(await newRepositoryEvents(app)).toHaveLength(1);
  });

  it('accept for an owner adds its new repository to the job repositories, and its issues become jobs', async () => {
    const { app, github, post, read } = await setup();
    const set = await post({ action: 'new-repositories', policy: { mode: 'ask', owners: { acme: 'accept' } } });
    expect(set.newRepositories?.policy).toEqual({ mode: 'ask', owners: { acme: 'accept' } });

    github.issues.push({ repo: 'acme/web', number: 2, title: 'New work', body: SLEEP, author: 'ada', labels: ['hopper'] });
    github.issues.push({ repo: 'octo/tools', number: 3, title: 'Other work', body: SLEEP, author: 'ada', labels: ['hopper'] });
    const after = await read();
    expect(after.jobRepositories).toEqual(['acme/api', 'acme/web']);
    expect(after.newRepositories?.asks.map((a) => a.repository)).toEqual(['octo/tools']);
    expect(await newRepositoryEvents(app)).toEqual([
      { type: 'connected_account.new_repositories_asked', data: { provider: 'github', account: 'ada', repositories: ['octo/tools'] } },
      { type: 'connected_account.new_repositories_accepted', data: { provider: 'github', account: 'ada', repositories: ['acme/web'] } },
    ]);
    await waitFor(async () => (await jobs(app)).find((j) => j.source?.repo === 'acme/web'), { what: 'the new repository\'s issue to become a job' });
  });

  it('refuses a policy of an owner with a slash', async () => {
    const { app } = await setup();
    const token = await app.login();
    const r = await app.ui('/ui/api/connected-accounts', { action: 'new-repositories', provider: 'github', policy: { mode: 'ask', owners: { 'acme/api': 'accept' } } }, { token });
    expect(r.status).toBe(400);
  });
});
