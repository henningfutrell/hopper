// The GitHub App source end to end through the real daemon: the in-memory fake GitHub with an app
// identity at the GitHubApi seam (AppSeams.githubApp): enablement and pausing, beside the connected account's source. What it writes to
// issues, including through HTTP against the node:http fake: github-writes.test.ts.
// Never the real GitHub. Issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { BOT, KEYS, appSecrets, jobSourcesDoc } from '../support/github-app.ts';
import { CREATE_APP_HINT } from '../../src/sources/github/source.ts';
import { connectGitHub } from '../support/github-account.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';

const REPO = 'owner/hopper-sandbox';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

/** `appKey`: the App's key is in the environment from the start; otherwise a test sets `secrets` itself. */
async function boot(o: { doc?: unknown; seams?: { github?: FakeGitHub; githubApp?: FakeGitHub }; appKey?: boolean }) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const secrets: Record<string, string | undefined> = o.appKey ? appSecrets() : {};
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { jobSources: o.doc ?? jobSourcesDoc() }, seams: { authorizationServer: createFakeAuthorizationServer(), ...o.seams }, secrets });
  apps.push(a);
  return { a, secrets };
}

const body = (op: Record<string, unknown>, text = 'Please do the thing.') => `${JSON.stringify(op)}\n\n${text}`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const status = async (a: TestApp, name: string): Promise<SourceStatus> =>
  (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === name)!;

describe('GitHub App source (in-memory fake at the seam)', () => {
  it('the connected account reads issues while no App is configured; github-app needs setup and says what is missing (issue #1243)', async () => {
    const gh = createFakeGitHub();
    const { a } = await boot({ seams: { github: gh }, doc: jobSourcesDoc({ githubApp: { appId: undefined, slug: undefined } }) });
    connectGitHub(a, [REPO]);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeDefined();
    expect(await status(a, 'github')).toMatchObject({ state: 'ok', detail: expect.objectContaining({ mode: 'account', login: 'owner' }) });
    expect((await status(a, 'github')).detail.paused).toBeUndefined();
    const app = await status(a, 'github-app');
    expect(app).toMatchObject({
      kind: 'github-app', state: 'needs-setup',
      setupProblem: { missing: ['appId', 'slug', 'private key'], help: 'github-app-setup' },
      detail: expect.objectContaining({ mode: 'app', paused: 'no GitHub App configured', setup: CREATE_APP_HINT }),
    });
    expect(app.lastOkAt).toBeUndefined();
  });

  it('an enabled app source with no key needs setup on its first pass; the key saved in the write-only field clears it without a restart (issue #1243)', async () => {
    const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const { a } = await boot({ seams: { githubApp: gh }, doc: jobSourcesDoc({ github: false }) });
    connectGitHub(a, [REPO]);
    const session = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    const before = await status(a, 'github-app');
    expect(before).toMatchObject({ state: 'needs-setup', itemsSeen: 0, setupProblem: { missing: ['private key'] } });
    expect(before.lastOkAt).toBeUndefined();
    expect(await jobFor(a, issue.url)).toBeUndefined();
    expect((await a.api('GET', '/api/github-app-key')).body).toEqual({ set: false });
    const bad = await a.ui<{ error: string }>('/ui/api/github-app-key', { action: 'set', value: 'not-a-key-0123456789' }, { token: session });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('not-a-key-0123456789');
    const saved = await a.ui<{ set: boolean }>('/ui/api/github-app-key', { action: 'set', value: KEYS.privateKey }, { token: session });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ set: true });
    const secretPart = KEYS.privateKey.trim().slice(40, 80);
    for (const path of ['/api/github-app-key', '/api/sources', '/api/vault', '/api/events?limit=1000']) expect(JSON.stringify((await a.api('GET', path)).body)).not.toContain(secretPart);
    await a.sync();
    const after = await status(a, 'github-app');
    expect(after.state).toBe('ok');
    expect(after.setupProblem).toBeUndefined();
    expect(await jobFor(a, issue.url)).toBeDefined();
  });

  it('a key the runtime gives at start is imported into the vault once (issue #1243)', async () => {
    const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const { a, secrets } = await boot({ appKey: true, seams: { githubApp: gh }, doc: jobSourcesDoc({ github: false }) });
    expect((await a.api('GET', '/api/github-app-key')).body).toMatchObject({ set: true, setBy: 'environment', environment: { variable: 'GITHUB_APP_PRIVATE_KEY' } });
    delete secrets.GITHUB_APP_PRIVATE_KEY;
    connectGitHub(a, [REPO]);
    await a.sync();
    expect((await status(a, 'github-app')).state).toBe('ok');
  });

  it('the app source takes issues assigned to the user\'s connected account; with none connected it is paused and says so (issue #387)', async () => {
    const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const { a } = await boot({ appKey: true, seams: { githubApp: gh }, doc: jobSourcesDoc({ github: false }) });
    expect(await status(a, 'github-app')).toMatchObject({ state: 'disabled', detail: expect.objectContaining({ paused: expect.stringMatching(/connect/i) }) });
    connectGitHub(a, [REPO]);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toMatchObject({ source: { assignee: 'owner', author: 'owner', origin: 'trusted' } });
  });

  it('enabled: false on both lists both disabled', async () => {
    const { a } = await boot({ doc: jobSourcesDoc({ github: { enabled: false }, githubApp: { enabled: false } }) });
    expect(await status(a, 'github')).toMatchObject({ kind: 'github-account', state: 'disabled' });
    expect(await status(a, 'github-app')).toMatchObject({ kind: 'github-app', state: 'disabled' });
  });
});
