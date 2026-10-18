// Issue #655, part 21: the nomination by a comment command (Decision N3). Through the real daemon, the fake GitHub at its
// seam and the OpenFGA double.
//
// Feature: the comment command
//   Scenario: the user nominates their own issue
//     Given a labelled issue the user wrote and did not assign
//     When the user comments /hopper run and a sync runs
//     Then its job is of a trusted origin at owner, nominated by the user, with no assignment
//   Scenario: the user asks for research
//     When the user comments /hopper research
//     Then its job is asked for research
//   Scenario: a stranger comments /hopper run
//     Then no job is made, and the issue waits to be assigned
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { StampView } from '../../src/domain/stamp-view.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobs = async (a: TestApp) => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const jobOf = (a: TestApp, url: string) => waitFor(async () => (await jobs(a)).find((j) => j.source?.key === url), { what: 'the job' });
const cardOf = async (a: TestApp, url: string): Promise<IntakeOutcome | undefined> =>
  ((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).find((x) => x.key === url);

describe('the comment command (issue #655, part 21)', () => {
  it('/hopper run by the user: a job of a trusted origin at owner, nominated, not assigned', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'owner', assignees: [], body: body('Fix the typo.'), labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', '/hopper run');
    await a.sync();
    const job = await jobOf(a, issue.url);
    expect(job.source).toMatchObject({ origin: 'trusted' });
    expect(job.source!.originActs).toContainEqual({ role: 'nominated', login: 'owner', trusted: true });
    expect(job.spec.research).toBeUndefined();
    expect((await a.api<StampView>('GET', `/api/jobs/${job.id}/stamp`)).body).toMatchObject({ level: 'owner' });
  });

  it('/hopper research by the user: its job is asked for research', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'owner', assignees: [], body: body('Is the cache needed?'), labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', '/hopper research');
    await a.sync();
    expect((await jobOf(a, issue.url)).spec.research).toBe(true);
  });

  it('/hopper run by a stranger: no job, and the issue waits to be assigned', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'owner', assignees: [], body: body('Fix the typo.'), labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'stranger', '/hopper run');
    await a.sync();
    expect(await cardOf(a, issue.url)).toMatchObject({ reason: 'not assigned to you' });
    expect((await jobs(a)).some((j) => j.source?.key === issue.url)).toBe(false);
  });
});
