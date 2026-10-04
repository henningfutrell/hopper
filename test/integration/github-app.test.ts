// The GitHub App source end to end through the real daemon: the in-memory fake GitHub with an app
// identity at the GitHubApi seam (AppSeams.githubApp), and once through HTTP against the node:http
// fake GitHub (JWT + scoped installation tokens), including the job's hopper-comment helper.
// Never the real GitHub. Issues carry a scripted-executor op as their first body line.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/app/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { APP_ID, BOT, KEYS, SLUG, appFilePath, jobSourcesDoc, writeAppFile } from '../support/github-app.ts';
import { waitFor } from '../support/wait.ts';
import { dirname } from 'node:path';

const REPO = 'owner/job-hopper-sandbox';
const OTHER = 'owner/not-installed';
const MARKER = '<!-- job-hopper v1 kind=job-comment -->';
const HOPPER_COMMENT = fileURLToPath(new URL('../../scripts/hopper-comment', import.meta.url));
const run = promisify(execFile);

const apps: TestApp[] = [];
const servers: FakeGitHubServer[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const c of cleanups.splice(0)) c();
});

async function boot(o: { doc?: (dir: string) => unknown; seams?: { github?: FakeGitHub; githubApp?: FakeGitHub }; appFile?: boolean }) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const dir = dirname(db.dbPath);
  if (o.appFile) writeAppFile(dir);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { jobSources: o.doc ? o.doc(dir) : jobSourcesDoc(dir) }, seams: o.seams ?? {} });
  apps.push(a);
  return { a, dir };
}

const body = (op: Record<string, unknown>, text = 'Please do the thing.') => `${JSON.stringify(op)}\n\n${text}`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const status = async (a: TestApp, name: string): Promise<SourceStatus> =>
  (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === name)!;
const envOf = (a: TestApp, url: string) => a.scripted.payloads.map((p) => p.env as Record<string, string>).find((e) => e.HOPPER_ISSUE_URL === url)!;

describe('GitHub App source (in-memory fake at the seam)', () => {
  it('claims as the bot, asks the human as the bot, takes the owner\'s marker-less reply, finishes, labels hopper:done', async () => {
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const { a } = await boot({ seams: { githubApp: app }, appFile: true, doc: (dir) => jobSourcesDoc(dir, { github: false }) });
    const issue = app.createIssue({ repo: REPO, title: 'Risky thing', body: body({ op: 'ask', message: 'Is this risky?' }), labels: ['hopper'] });
    const elsewhere = app.createIssue({ repo: OTHER, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();

    expect(await jobFor(a, elsewhere.url)).toBeUndefined();
    expect(app.commentsOn(OTHER, elsewhere.number)).toEqual([]);
    const job = (await jobFor(a, issue.url))!;
    expect(job.source).toMatchObject({ source: 'github-app', kind: 'github-app', key: issue.url, repo: REPO });
    await waitFor(() => app.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claimed label' });
    expect(app.commentsOn(REPO, issue.number)[0]).toMatchObject({ author: BOT });

    const env = envOf(a, issue.url);
    expect(env.HOPPER_COMMENT_CMD).toBe(HOPPER_COMMENT);
    const tokenFile = env.HOPPER_TOKEN_FILE!;
    await waitFor(() => existsSync(tokenFile), { what: 'token file' });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ version: 1, repo: REPO, issue: issue.number, token: expect.any(String) });

    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await waitFor(() => app.commentsOn(REPO, issue.number).find((c) => c.body.includes('Is this risky?')), { what: 'question comment' });
    expect(app.commentsOn(REPO, issue.number).every((c) => c.author === BOT)).toBe(true);

    app.addComment(REPO, issue.number, BOT, 'a bot comment without a marker');
    app.addComment(REPO, issue.number, 'stranger', 'yes do it');
    await a.sync();
    expect((await a.job(job.id)).status).toBe('waiting_answer');

    app.addComment(REPO, issue.number, 'owner', 'go ahead');
    await a.sync();
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: 'go ahead' });
    expect((await a.api('GET', `/api/questions/${q.id}`)).body).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'go ahead' });
    await waitFor(() => app.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    const finished = app.commentsOn(REPO, issue.number).find((c) => c.body.includes('kind=finished'));
    expect(finished).toMatchObject({ author: BOT });
    await waitFor(() => !existsSync(tokenFile), { what: 'token file removed' });
    expect(await status(a, 'github-app')).toMatchObject({ kind: 'github-app', state: 'ok', detail: expect.objectContaining({ mode: 'app', installedRepos: [REPO] }) });
  });

  it('gh with enabled auto pauses once the app file appears mid-run, yet finishes its own active job', async () => {
    const gh = createFakeGitHub();
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [] } });
    const { a, dir } = await boot({ seams: { github: gh, githubApp: app }, doc: (d) => jobSourcesDoc(d, { github: { repos: [REPO] } }) });
    const first = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 800 }), labels: ['hopper'] });
    await a.sync();
    const j1 = (await jobFor(a, first.url))!;
    await a.waitForStatus(j1.id, 'running');
    expect((await status(a, 'github')).detail.paused).toBeUndefined();

    writeAppFile(dir);
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

  it('gh runs while no app file exists; github-app is disabled and says how to create the app', async () => {
    const gh = createFakeGitHub();
    const { a } = await boot({ seams: { github: gh }, doc: (d) => jobSourcesDoc(d, { github: { repos: [REPO] } }) });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeDefined();
    expect(await status(a, 'github')).toMatchObject({ state: 'ok', detail: expect.objectContaining({ mode: 'gh', enabledSetting: 'auto' }) });
    expect((await status(a, 'github')).detail.paused).toBeUndefined();
    expect(await status(a, 'github-app')).toMatchObject({
      kind: 'github-app', state: 'disabled',
      detail: expect.objectContaining({ mode: 'app', paused: 'no GitHub App configured', setup: 'run bash ~/.local/lib/job-hopper/scripts/create-github-app.sh' }),
    });
  });

  it('githubApp.authors containing the bot login is refused when the app file is readable', async () => {
    const { a } = await boot({ appFile: true, doc: (d) => jobSourcesDoc(d, { github: false, githubApp: { authors: ['owner', BOT] } }) });
    const st = await status(a, 'github-app');
    expect(st).toMatchObject({ state: 'error' });
    expect(st.lastError).toMatch(/authors must not contain the app bot/);
  });

  it('enabled: false on both lists both disabled', async () => {
    const { a } = await boot({ doc: (d) => jobSourcesDoc(d, { github: { enabled: false }, githubApp: { enabled: false } }) });
    expect(await status(a, 'github')).toMatchObject({ kind: 'github', state: 'disabled' });
    expect(await status(a, 'github-app')).toMatchObject({ kind: 'github-app', state: 'disabled' });
  });
});

describe('GitHub App source through HTTP (node:http fake GitHub, real App adapter)', () => {
  it('claims, the job comments as the bot with hopper-comment, the owner answers, the bot reports done; token file scoped then removed', async () => {
    const fake = await createFakeGitHubServer({
      appId: APP_ID, publicKeyPem: KEYS.publicKey, slug: SLUG,
      installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'job-hopper-sandbox', labels: ['hopper'], issues: [
        { number: 1, title: 'Risky thing', author: 'owner', labels: ['hopper'], body: body({ op: 'ask', message: 'Is this risky?' }) },
      ] }] }],
    });
    servers.push(fake);
    const { a } = await boot({ appFile: true, doc: (d) => jobSourcesDoc(d, { github: false, githubApp: { apiUrl: fake.url } }) });
    const issue = fake.state.repos.get(REPO)!.issues.get(1)!;
    const url = `https://github.com/${REPO}/issues/1`;
    await a.sync();
    const job = (await jobFor(a, url))!;
    expect(job.source).toMatchObject({ source: 'github-app', key: url });
    await waitFor(() => issue.labels.includes('hopper:claimed'), { what: 'claimed label' });
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await waitFor(() => issue.comments.find((c) => c.body.includes('Is this risky?')), { what: 'question comment' });
    expect(issue.comments.every((c) => c.author === BOT)).toBe(true);

    const env = envOf(a, url);
    expect(env).toMatchObject({ HOPPER_GITHUB_API: fake.url, HOPPER_COMMENT_CMD: HOPPER_COMMENT, HOPPER_COMMENT_MARKER: MARKER });
    await waitFor(() => existsSync(env.HOPPER_TOKEN_FILE!), { what: 'token file' });
    expect(fake.state.tokens.some((t) => JSON.stringify(t.body) === JSON.stringify({ repositories: ['job-hopper-sandbox'], permissions: { issues: 'write' } }))).toBe(true);
    const out = await run('bash', [HOPPER_COMMENT, 'working on it'], { env: { PATH: process.env.PATH ?? '', ...env } });
    expect(out.stdout).toMatch(/issuecomment/);
    expect(issue.comments.at(-1)).toMatchObject({ author: BOT, body: `${MARKER}\nworking on it` });

    await a.sync();
    expect((await a.job(job.id)).status).toBe('waiting_answer');
    issue.comments.push({ id: fake.state.nextCommentId++, author: 'owner', body: 'go ahead', createdAt: new Date().toISOString() });
    await a.sync();
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'go ahead' });
    await waitFor(() => issue.labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(issue.comments.find((c) => c.body.includes('kind=finished'))).toMatchObject({ author: BOT });
    await waitFor(() => !existsSync(env.HOPPER_TOKEN_FILE!), { what: 'token file removed' });
    expect(await status(a, 'github-app')).toMatchObject({ state: 'ok', detail: expect.objectContaining({ slug: SLUG, installedRepos: [REPO] }) });
    expect(existsSync(appFilePath(dirname(a.dbPath)))).toBe(true);
  });
});
