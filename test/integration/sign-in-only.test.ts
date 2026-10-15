// GitHub through the sign-in alone (issue #1377), through the real daemon against the node:http fake GitHub: a hopper with
// only a GitHub sign-in (the hopper's app's user token) and chosen job repositories — no App id, slug or private key
// anywhere — lists its open `hopper`-labelled issues assigned to the user, takes a trusted one as a job, shows the others
// in Intake, and its Approve and Assign to me reach GitHub with that same token.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
let a: TestApp | undefined;
let fake: FakeGitHubServer | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  await fake?.close();
  cleanup?.();
  a = fake = cleanup = undefined;
});

const source = async (app: TestApp): Promise<SourceStatus> =>
  (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github')!;
const intake = async (app: TestApp): Promise<IntakeOutcome[]> => (await source(app)).detail.intake as IntakeOutcome[];

describe('GitHub through the sign-in alone (issue #1377)', () => {
  it('a sign-in and chosen repositories list, take and act on issues; every call carries the user\'s token', async () => {
    fake = await createFakeGitHubServer({
      login: 'owner', token: TEST_ACCOUNT_TOKEN,
      installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: [
        { number: 1, title: 'Mine', author: 'owner', labels: ['hopper'], assignees: ['owner'], body: '{"op":"echo"}\n\nDo it.' },
        { number: 2, title: 'From a stranger', author: 'stranger', labels: ['hopper'], assignees: ['owner'], body: 'Please do it.' },
        { number: 3, title: 'Not mine yet', author: 'owner', labels: ['hopper'], assignees: [], body: 'Do it later.' },
      ] }] }],
    });
    const db = tempDbPath();
    cleanup = db.cleanup;
    a = await startTestApp({ dbPath: db.dbPath, env: fakeGitHubEnv(fake), plugins: { jobSources: [githubSource({ executor: 'scripted' })] } });
    connectGitHub(a, [REPO]);
    await a.sync();

    const status = await source(a);
    expect(status).toMatchObject({ kind: 'github-account', state: 'ok' });
    expect(status.detail.paused).toBeUndefined();
    const jobs = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    expect(jobs.map((j) => j.source?.key)).toEqual([url(1)]);
    const items = await intake(a);
    const card = items.find((x) => x.key === url(2));
    expect(card).toMatchObject({ action: 'approve' });
    expect(items.find((x) => x.key === url(3))).toMatchObject({ action: 'assign' });

    const token = await a.login();
    const assigned = await a.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [url(3)] }, { token });
    expect(assigned).toMatchObject({ status: 200, body: { done: [url(3)], failed: {} } });
    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [url(2)], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [url(2)], failed: {} } });
    const issues = fake.state.repos.get(REPO)!.issues;
    await waitFor(() => issues.get(3)!.assignees.includes('owner'), { what: 'issue 3 assigned to the signed-in user on GitHub' });

    // One identity: every call the fake saw carried the connected account's token; no App JWT, no installation token.
    expect(fake.state.requests.length).toBeGreaterThan(0);
    expect(fake.state.requests.filter((r) => r.auth !== 'token').map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(fake.state.requests.filter((r) => r.path.startsWith('/app/') || r.path.endsWith('/installation'))).toEqual([]);
  });
});
