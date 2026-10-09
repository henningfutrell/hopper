// Yolo mode (issue #579) over the real HTTP server and database: off by default; an admin turns it on for every job
// repository or per repository, which wins; the next job's prompt says the job may merge its pull request, and a job
// whose pull request is open and ready for review is done either way — the merge is never needed. Fake GitHub at
// the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { opensPullRequest } from '../support/scripted-executor.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OTHER = 'owner/other';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO, OTHER]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const doneLine = (job: Job) => String(job.spec.payload.prompt).split('\n').find((l) => l.startsWith('done'))!;
const MERGE = 'Yolo mode is on for this repo';
const NO_MERGE = 'Do not merge it: a person reviews and merges it';

describe('yolo mode', () => {
  it('is off by default: GET says so and lists the job repositories; a job is told not to merge', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    expect((await app.api('GET', '/api/yolo-mode')).body).toEqual({ on: false, repos: {}, choices: { repos: [REPO, OTHER] } });
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 60_000 }), labels: ['hopper'] });
    await app.sync();
    expect(doneLine(await jobFor(app, issue.url))).toContain(NO_MERGE);
  });

  it('an admin turns it on for one repository: that repository\'s next job may merge, the other\'s may not; recorded with who', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const r = await app.ui('/ui/api/yolo-mode', { repos: { 'Owner/Hopper-Sandbox': true } }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ on: false, repos: { [REPO]: true }, choices: { repos: [REPO, OTHER] } });
    const mine = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 60_000 }), labels: ['hopper'] });
    const other = gh.createIssue({ repo: OTHER, body: body({ op: 'sleep', ms: 60_000 }), labels: ['hopper'] });
    await app.sync();
    expect(doneLine(await jobFor(app, mine.url))).toContain(MERGE);
    expect(doneLine(await jobFor(app, other.url))).toContain(NO_MERGE);
    const [changed] = await app.events('types=yolo_mode.changed');
    expect(changed!.data).toMatchObject({ from: { on: false, repos: {} }, to: { on: false, repos: { [REPO]: true } } });
    expect(typeof changed!.data.by).toBe('string');
  });

  it('on for every repository, off for one; null follows `on` again; a save that changes nothing records nothing', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { on: true, repos: { [OTHER]: false } }, { token })).body).toMatchObject({ on: true, repos: { [OTHER]: false } });
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [OTHER]: null } }, { token })).body).toMatchObject({ on: true, repos: {} });
    expect((await app.ui('/ui/api/yolo-mode', { on: true }, { token })).status).toBe(200);
    expect(await app.events('types=yolo_mode.changed')).toHaveLength(2);
  });

  it('refused without a UI session, or with nothing to change, or a name that is no repository', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    expect((await app.ui('/ui/api/yolo-mode', { on: true })).status).toBe(403);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', {}, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/yolo-mode', { repos: { 'not a repo': true } }, { token })).status).toBe(400);
    expect((await app.api('GET', '/api/yolo-mode')).body).toMatchObject({ on: false, repos: {} });
  });

  it('done does not depend on it: with yolo mode off, a job whose pull request is open and ready ends done, the issue open', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    app.scripted.ships(opensPullRequest(gh));
    await app.sync();
    const job = await jobFor(app, issue.url);
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'the end label' });
    expect(gh.issue(REPO, issue.number).state).toBe('open');
  });
});
