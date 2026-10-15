// Auto-approval end to end (issue #1268), through the real daemon, store and HTTP edge, the fake GitHub at its seam and the
// OpenFGA double.
//
// Feature: auto-approval at intake
//   Scenario: an admin's setting, on by default
//     Then GET /api/intake-auto-approval says on, with no app listed
//     And only an admin changes it; each app is kept by its slug; a change is recorded with who
//   Scenario: an issue the user wrote, labelled through an app
//     Then the hopper approves it (source.request_auto_approved, rule and actor), no request card opens, and its job runs
//   Scenario: auto-approval off
//     Then the same issue is a request card, as before
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const cardOf = async (a: TestApp, url: string): Promise<IntakeOutcome | undefined> =>
  ((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).find((x) => x.key === url);

describe('auto-approval at intake (issue #1268)', () => {
  it('is an admin\'s setting, on by default; apps are kept by slug and a change is recorded', async () => {
    const a = await boot(createFakeGitHub());
    expect((await a.api('GET', '/api/intake-auto-approval')).body).toEqual({ on: true, apps: [] });
    expect((await a.ui('/ui/api/intake-auto-approval', { on: false, apps: [] })).status).toBe(403);
    const token = await a.login();
    expect((await a.ui('/ui/api/intake-auto-approval', { on: true, apps: ['not a slug'] }, { token })).status).toBe(400);
    expect(await a.ui('/ui/api/intake-auto-approval', { on: true, apps: ['Helper[bot]', 'ci-app', 'helper'] }, { token }))
      .toMatchObject({ status: 200, body: { on: true, apps: ['ci-app', 'helper'] } });
    await a.ui('/ui/api/intake-auto-approval', { on: true, apps: ['helper', 'ci-app'] }, { token });
    expect((await a.events('types=intake.auto_approval_changed')).map((e) => e.data)).toEqual([
      expect.objectContaining({ from: { on: true, apps: [] }, to: { on: true, apps: ['ci-app', 'helper'] } }),
    ]);
  });

  it('an issue the user wrote, labelled through an app, is approved by the hopper and its job runs the text', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body('Fix the typo.'), labels: ['hopper'], labelledBy: 'helper[bot]' });
    await a.sync();
    expect(await cardOf(a, issue.url)).toMatchObject({ reason: 'approved by the hopper: written by owner; taken at the next sync' });
    expect((await a.events('types=source.request_auto_approved')).map((e) => e.data)).toEqual([expect.objectContaining({
      source: 'github', key: issue.url, author: 'owner', rule: 'author', actor: 'owner',
    })]);
    expect(await a.events('types=source.request_opened')).toEqual([]);
    await a.sync();
    const [job] = await waitFor(async () => { const js = await jobsFor(a, issue.url); return js.length ? js : undefined; }, { what: 'the approved job' });
    expect(job).toMatchObject({ source: { origin: 'approved' }, spec: { payload: { body: body('Fix the typo.') } } });
  });

  it('off: the same issue is a request card', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    await a.ui('/ui/api/intake-auto-approval', { on: false, apps: [] }, { token });
    const issue = gh.createIssue({ repo: REPO, body: body('Fix the typo.'), labels: ['hopper'], labelledBy: 'helper[bot]' });
    await a.sync();
    expect(await cardOf(a, issue.url)).toMatchObject({ action: 'approve', request: { why: ['labelled by an app or a bot (helper[bot])'] } });
    expect(await a.events('types=source.request_auto_approved')).toEqual([]);
    expect(await jobsFor(a, issue.url)).toEqual([]);
  });
});
