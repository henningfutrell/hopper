// The check before a nudge (issue #627), through the real daemon: the engine reads the job's source — the GitHub
// source over an in-memory fake GitHub at the GitHubApi seam — and what the job waits on in the hopper. The
// scripted executor's op `before-nudge` asks it as the herdr-claude executor does before it nudges.
//
// Feature: a job is not nudged when nothing is left for it to do
//   Scenario: the job's pull request is ready for review → done
//   Scenario: the job's issue is closed → done
//   Scenario: the job waits on a person (an open watch on its job stream) → waiting
//   Scenario: none of these → nudge
//   Scenario: a job of a source that judges nothing → nudge
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { opensPullRequest } from '../support/scripted-executor.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OP = `${JSON.stringify({ op: 'before-nudge' })}\n\nPlease do the thing.`;
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

async function checkFor(a: TestApp, gh: FakeGitHub): Promise<Job> {
  const issue = gh.createIssue({ repo: REPO, body: OP, labels: ['hopper'] });
  await a.sync();
  const job = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
  await waitFor(() => a.scripted.checks.length > 0, { what: 'the check before a nudge' });
  return job;
}

describe('the check before a nudge (issue #627)', () => {
  it('the job\'s pull request is ready for review: done', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    a.scripted.ships(opensPullRequest(gh));
    await checkFor(a, gh);
    expect(a.scripted.checks).toEqual([{ done: 'its pull request is ready for review, or its issue is closed as complete' }]);
  });

  it('the job\'s issue is closed: done', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    a.scripted.ships((j) => gh.closeIssue(REPO, j.source!.number!, undefined, { reason: 'not_planned' }));
    await checkFor(a, gh);
    expect(a.scripted.checks).toEqual([{ done: 'its issue is closed' }]);
  });

  it('the job waits on a person: an open watch on its job stream', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    a.scripted.ships((j) => a.user().store.jobStream.open({
      id: 'request-1', jobId: j.id, deadline: new Date(Date.now() + 3600000).toISOString(), body: { name: 'example-api' }, openedAt: new Date().toISOString(),
    }));
    await checkFor(a, gh);
    expect(a.scripted.checks).toEqual([{ waiting: 'a skill request for example-api' }]);
  });

  it('none of these: nudge', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await checkFor(a, gh);
    expect(a.scripted.checks).toEqual([{ nudge: true }]);
  });

  it('a job of a source that judges nothing: nudge', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, env: {} });
    apps.push(a);
    const job = await a.pull({ op: 'before-nudge' });
    await a.waitForStatus(job.id, 'finished');
    expect(a.scripted.checks).toEqual([{ nudge: true }]);
  });
});
