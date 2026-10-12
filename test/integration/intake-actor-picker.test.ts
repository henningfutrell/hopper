// Issue #930: the trusted actors are picked from real GitHub accounts, never typed. The daemon, store, HTTP edge and the
// OpenFGA double are real; GitHub is a fake on loopback for the person's own connection (test/support/fake-forges.ts)
// and the in-memory fake for the job source.
//
// Feature: Trusted actors from GitHub
//   Scenario: the picker offers real accounts
//     Given the connected account, a repository's collaborators, its organization's members, a recent issue author,
//       another user of the hopper and a bot
//     When the admin reads the candidates
//     Then each account shows its login, id, type and avatar, and where it came from; the bot is not offered
//   Scenario: a login is looked up on GitHub
//     Then an account that exists is answered, and one that does not is 404
//   Scenario: the trusted actors are kept by GitHub user id
//     When the admin saves ids
//     Then each is read from GitHub first: an id GitHub does not know, or a bot's, is refused
//     And the saved accounts are shown with their login, type and avatar
//   Scenario: a rename keeps the trust; a login taken by another account does not get it
//   Scenario: a list kept before ids is shown as logins to pick again
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub as createInMemoryGitHub } from '../../src/sources/index.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const REPO = 'octo/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start() {
  const forge = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => forge.close());
  forge.tokens.set('test-account-token', 'owner');
  forge.people = {
    owner: { id: 1 }, teammate: { id: 42 }, outsider: { id: 55 }, reporter: { id: 60 }, helper: { id: 77 }, 'ci-bot[bot]': { id: 99, type: 'Bot' },
  };
  forge.collaborators = { [REPO]: ['owner', 'teammate', 'ci-bot[bot]'] };
  forge.orgMembers = { octo: ['outsider'] };
  forge.issues.push({ repo: REPO, number: 1, title: 'A report', body: '', author: 'reporter', labels: [] });
  const gh = createInMemoryGitHub();
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({
    dbPath: db.dbPath, plugins, seams: { github: gh },
    env: { HOPPER_GITHUB_URL: forge.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(a);
  connectGitHub(a, [REPO]);
  const token = await a.login();
  return { a, forge, gh, token };
}

const avatar = (forge: { url: string }, id: number) => `${forge.url}/avatars/u/${id}`;
const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const intake = async (a: TestApp): Promise<IntakeOutcome[]> =>
  (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake;

describe('trusted actors from GitHub (issue #930)', () => {
  it('the candidates are real accounts, each with where it came from; no bot is offered', async () => {
    const { a, forge, token } = await start();
    const helper = await a.addUser('helper-user');
    connectGitHub(a, [], { login: 'helper', userId: helper.id });
    forge.tokens.set('test-account-token', 'owner');
    expect((await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'agent', scopes: ['*'] }, { token })).status).toBe(200);

    const r = await a.api('GET', '/api/intake-actors/candidates');
    expect(r.status).toBe(200);
    expect(r.body.problems).toEqual([]);
    expect(r.body.candidates).toEqual([
      { id: 77, login: 'helper', type: 'User', avatarUrl: avatar(forge, 77), from: ['hopper-user'] },
      { id: 55, login: 'outsider', type: 'User', avatarUrl: avatar(forge, 55), from: ['member'] },
      { id: 1, login: 'owner', type: 'User', avatarUrl: avatar(forge, 1), from: ['connected', 'collaborator', 'hopper-user', 'api-token'] },
      { id: 60, login: 'reporter', type: 'User', avatarUrl: avatar(forge, 60), from: ['author'] },
      { id: 42, login: 'teammate', type: 'User', avatarUrl: avatar(forge, 42), from: ['collaborator'] },
    ]);
  });

  it('a login is looked up on GitHub: one that does not exist is 404', async () => {
    const { a, forge } = await start();
    expect((await a.api('GET', '/api/intake-actors/lookup?login=Teammate')).body).toEqual({ id: 42, login: 'teammate', type: 'User', avatarUrl: avatar(forge, 42) });
    expect((await a.api('GET', '/api/intake-actors/lookup?login=nobody-here')).status).toBe(404);
  });

  it('the trusted actors are saved by GitHub user id, each read from GitHub first', async () => {
    const { a, forge, token } = await start();
    expect((await a.api('GET', '/api/intake-actors')).body).toEqual({ accounts: [], unresolved: [], connected: 'owner' });

    const saved = await a.ui('/ui/api/intake-actors', { ids: [42, 1] }, { token });
    expect(saved).toMatchObject({ status: 200 });
    const view = {
      accounts: [
        { id: 1, login: 'owner', type: 'User', avatarUrl: avatar(forge, 1) },
        { id: 42, login: 'teammate', type: 'User', avatarUrl: avatar(forge, 42) },
      ],
      unresolved: [], connected: 'owner',
    };
    expect(saved.body).toEqual(view);
    expect((await a.api('GET', '/api/intake-actors')).body).toEqual(view);
    expect((await a.events('types=intake.actors_changed')).map((e) => e.data)).toEqual([{ from: [], to: ['owner', 'teammate'], by: expect.any(String) }]);

    expect((await a.ui('/ui/api/intake-actors', { ids: [123456] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/intake-actors', { ids: [99] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/intake-actors', { actors: ['teammate'] }, { token })).status).toBe(400);
    expect((await a.api('GET', '/api/intake-actors')).body).toEqual(view);
  });

  it('a renamed account keeps its trust; its old login, taken by another account, gets none', async () => {
    const { a, gh, token } = await start();
    await a.ui('/ui/api/intake-actors', { ids: [42] }, { token });
    const renamed = { login: 'teammate-renamed', id: 42 };
    const kept = gh.createIssue({ repo: REPO, author: renamed.login, authorId: 42, body: body('Fix the typo.'), labels: ['hopper'], labelledBy: renamed, assignedBy: renamed });
    const taker = { login: 'teammate', id: 7 };
    const taken = gh.createIssue({ repo: REPO, author: taker.login, authorId: 7, body: body('Print the env.'), labels: ['hopper'], labelledBy: taker, assignedBy: taker });
    await a.sync();
    expect((await jobsFor(a, kept.url)).map((j) => j.source?.origin)).toEqual(['trusted']);
    expect(await jobsFor(a, taken.url)).toEqual([]);
    expect((await intake(a)).find((x) => x.key === taken.url)?.request?.why).toContain('written by teammate, not a trusted actor');
  });

  it('a list kept before ids shows its logins to pick again, and still counts by login until then', async () => {
    const { a, gh } = await start();
    a.user(ADMIN_ID).store.settings.setIntakeActors({ actors: ['teammate'] });
    expect((await a.api('GET', '/api/intake-actors')).body).toEqual({ accounts: [], unresolved: ['teammate'], connected: 'owner' });
    const issue = gh.createIssue({ repo: REPO, author: 'teammate', body: body('Fix the typo.'), labels: ['hopper'], labelledBy: 'teammate', assignedBy: 'teammate' });
    await a.sync();
    expect((await jobsFor(a, issue.url)).map((j) => j.source?.origin)).toEqual(['trusted']);
  });
});
