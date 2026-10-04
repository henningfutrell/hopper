// The GitHub App source end to end through the real daemon: the in-memory fake GitHub with an app
// identity at the GitHubApi seam (AppSeams.githubApp): enablement and pausing. What it writes to
// issues, including through HTTP against the node:http fake: github-writes.test.ts.
// Never the real GitHub. Issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { BOT, appSecrets, jobSourcesDoc } from '../support/github-app.ts';
import { CREATE_APP_HINT } from '../../src/sources/github/source.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/job-hopper-sandbox';

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
  it('gh with enabled auto pauses once the App key appears in the environment mid-run, yet finishes its own active job', async () => {
    const gh = createFakeGitHub();
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [] } });
    const { a, secrets } = await boot({ seams: { github: gh, githubApp: app }, doc: jobSourcesDoc({ github: { repos: [REPO] } }) });
    const first = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 800 }), labels: ['hopper'] });
    await a.sync();
    const j1 = (await jobFor(a, first.url))!;
    await a.waitForStatus(j1.id, 'running');
    expect((await status(a, 'github')).detail.paused).toBeUndefined();

    Object.assign(secrets, appSecrets());
    const second = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, second.url)).toBeUndefined();
    expect(await status(a, 'github')).toMatchObject({ state: 'ok', activeJobs: 1, detail: expect.objectContaining({ paused: 'GitHub App configured', enabledSetting: 'auto' }) });

    await a.waitForStatus(j1.id, 'finished');
    await waitFor(() => gh.issue(REPO, first.number).labels.includes('hopper:done'), { what: 'hopper:done on the gh job' });
    await a.sync();
    expect(await status(a, 'github')).toMatchObject({ state: 'disabled', activeJobs: 0 });
    expect(await jobFor(a, second.url)).toBeUndefined();
    expect((await status(a, 'github-app')).detail).toMatchObject({ mode: 'app', installedRepos: [], setup: expect.stringMatching(/^install the app/) });
  });

  it('gh runs while no App is configured; github-app is disabled and says how to create the app', async () => {
    const gh = createFakeGitHub();
    const { a } = await boot({ seams: { github: gh }, doc: jobSourcesDoc({ github: { repos: [REPO] }, githubApp: { appId: undefined, slug: undefined } }) });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeDefined();
    expect(await status(a, 'github')).toMatchObject({ state: 'ok', detail: expect.objectContaining({ mode: 'gh', enabledSetting: 'auto' }) });
    expect((await status(a, 'github')).detail.paused).toBeUndefined();
    expect(await status(a, 'github-app')).toMatchObject({
      kind: 'github-app', state: 'disabled',
      detail: expect.objectContaining({ mode: 'app', paused: 'no GitHub App configured', setup: CREATE_APP_HINT }),
    });
  });

  it('githubApp.authors containing the bot login is refused when the App is configured', async () => {
    const { a } = await boot({ appKey: true, doc: jobSourcesDoc({ github: false, githubApp: { authors: ['owner', BOT] } }) });
    const st = await status(a, 'github-app');
    expect(st).toMatchObject({ state: 'error' });
    expect(st.lastError).toMatch(/authors must not contain the app bot/);
  });

  it('enabled: false on both lists both disabled', async () => {
    const { a } = await boot({ doc: jobSourcesDoc({ github: { enabled: false }, githubApp: { enabled: false } }) });
    expect(await status(a, 'github')).toMatchObject({ kind: 'github', state: 'disabled' });
    expect(await status(a, 'github-app')).toMatchObject({ kind: 'github-app', state: 'disabled' });
  });
});
