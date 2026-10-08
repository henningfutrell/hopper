// The GitHub App source end to end through the real daemon: the in-memory fake GitHub with an app
// identity at the GitHubApi seam (AppSeams.githubApp): enablement and pausing, beside the connected account's source. What it writes to
// issues, including through HTTP against the node:http fake: github-writes.test.ts.
// Never the real GitHub. Issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { BOT, appSecrets, jobSourcesDoc } from '../support/github-app.ts';
import { CREATE_APP_HINT } from '../../src/sources/github/source.ts';
import { connectGitHub } from '../support/github-account.ts';

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
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { jobSources: o.doc ?? jobSourcesDoc() }, seams: o.seams ?? {}, secrets });
  apps.push(a);
  return { a, secrets };
}

const body = (op: Record<string, unknown>, text = 'Please do the thing.') => `${JSON.stringify(op)}\n\n${text}`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const status = async (a: TestApp, name: string): Promise<SourceStatus> =>
  (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === name)!;

describe('GitHub App source (in-memory fake at the seam)', () => {
  it('the connected account reads issues while no App is configured; github-app is disabled and says how to create the app', async () => {
    const gh = createFakeGitHub();
    const { a } = await boot({ seams: { github: gh }, doc: jobSourcesDoc({ githubApp: { appId: undefined, slug: undefined } }) });
    connectGitHub(a, [REPO]);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeDefined();
    expect(await status(a, 'github')).toMatchObject({ state: 'ok', detail: expect.objectContaining({ mode: 'account', login: 'owner' }) });
    expect((await status(a, 'github')).detail.paused).toBeUndefined();
    expect(await status(a, 'github-app')).toMatchObject({
      kind: 'github-app', state: 'disabled',
      detail: expect.objectContaining({ mode: 'app', paused: 'no GitHub App configured', setup: CREATE_APP_HINT }),
    });
  });

  it('the app source takes issues assigned to the user\'s connected account; with none connected it is paused and says so (issue #387)', async () => {
    const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const { a } = await boot({ appKey: true, seams: { githubApp: gh }, doc: jobSourcesDoc({ github: false }) });
    expect(await status(a, 'github-app')).toMatchObject({ state: 'disabled', detail: expect.objectContaining({ paused: expect.stringMatching(/connect/i) }) });
    connectGitHub(a, [REPO]);
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toMatchObject({ source: { assignee: 'owner', author: 'stranger' } });
  });

  it('enabled: false on both lists both disabled', async () => {
    const { a } = await boot({ doc: jobSourcesDoc({ github: { enabled: false }, githubApp: { enabled: false } }) });
    expect(await status(a, 'github')).toMatchObject({ kind: 'github-account', state: 'disabled' });
    expect(await status(a, 'github-app')).toMatchObject({ kind: 'github-app', state: 'disabled' });
  });
});
