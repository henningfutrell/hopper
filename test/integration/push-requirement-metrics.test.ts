// Push requirement metrics (issue #2555 part 5, design.md "Push requirements"): a CI run of a job's pull request that fails on
// a check a requirement that applied mirrors is recorded once as a CI miss, and `GET /api/push-requirements/metrics` reports
// the CI runs caught on the job's machine, the billed minutes saved, and the CI misses. Real daemon, in-memory fake GitHub.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
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
  connectGitHub(a, [REPO]);
  return a;
}

const ci = { checks: ['coverage*'], minutes: 47 };
const evaluated = (head: string, passed: boolean) => ({
  repo: REPO, branch: 'issue-1', base: 'dev', head, passed,
  requirements: [
    { id: 'kotlin-coverage', level: 'repo', status: passed ? 'passed' : 'failed', checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: passed ? 0 : 1, passed, ci }] },
    { id: 'migrations', level: 'repo', status: 'skipped', reason: 'no changed files match `**/*.sql`' },
  ],
});

describe('push requirement metrics (issue #2555 part 5)', () => {
  it('records a CI run that failed on a check a requirement that applied mirrors, once, and reports it with the runs caught here', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nPlease do the thing.', labels: ['hopper'] });
    let url: string | undefined;
    app.scripted.ships((j) => { url ??= gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), headOid: 'c0ffee12' }).url; });
    await app.sync();
    const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.find((j) => j.source?.key === issue.url)!;
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    // The job's evaluations: one commit failed here (a CI run caught), then the pushed head passed here.
    const events = app.user().store.events;
    events.append({ type: 'push_requirements.evaluated', jobId: job.id, data: evaluated('bad00001', false) });
    events.append({ type: 'push_requirements.evaluated', jobId: job.id, data: evaluated('c0ffee12', true) });

    gh.setChecks(url!, 'failing', [{ name: 'test (1)' }, { name: 'coverage (changed files)', url: `${url}/checks` }]);
    await app.sync();
    await app.sync();
    const missed = await app.events('types=push_requirements.ci_missed');
    expect(missed.map((e) => [e.jobId, e.data])).toEqual([[job.id, {
      repo: REPO, pullRequest: url, head: 'c0ffee12', checks: ['coverage (changed files)'], requirements: ['kotlin-coverage'], minutes: 47,
    }]]);

    const m = await app.api('GET', '/api/push-requirements/metrics');
    expect(m.status).toBe(200);
    expect(m.body).toEqual({
      days: 30, caught: 1, minutesSaved: 47, unpriced: 0, missed: 1, minutesMissed: 47,
      repos: [{ repo: REPO, caught: 1, minutesSaved: 47, unpriced: 0, missed: 1, minutesMissed: 47 }],
    });
    expect((await app.api('GET', '/api/push-requirements/metrics?days=0')).status).toBe(400);
  });

  it('records no CI miss when the failed check is one no requirement mirrors', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: '{"op":"echo"}\n\nPlease do the thing.', labels: ['hopper'] });
    let url: string | undefined;
    app.scripted.ships((j) => { url ??= gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date().toISOString(), headOid: 'c0ffee12' }).url; });
    await app.sync();
    const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.find((j) => j.source?.key === issue.url)!;
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
    app.user().store.events.append({ type: 'push_requirements.evaluated', jobId: job.id, data: evaluated('c0ffee12', true) });
    gh.setChecks(url!, 'failing', [{ name: 'test (1)' }]);
    await app.sync();
    expect(await app.events('types=push_requirements.ci_missed')).toEqual([]);
    expect((await app.api('GET', '/api/push-requirements/metrics')).body).toMatchObject({ caught: 0, missed: 0 });
  });
});
