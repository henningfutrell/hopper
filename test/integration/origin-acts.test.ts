// Issue #655, part 14: the origin acts kept with a job — who wrote its item, who added the label and who assigned it,
// through which app, and whether a trusted actor did each — through the real daemon, the fake GitHub at its seam and the
// OpenFGA double.
//
// Feature: origin acts
//   Scenario: the user's own issue
//     Given an issue the user wrote, labelled and assigned
//     When a sync takes it
//     Then its job keeps the three acts, each by the user and trusted
//     And the stamp view says the same
//   Scenario: a request card a person approved
//     Given an issue a stranger wrote, labelled through an app
//     When a person approves its card and a sync takes it
//     Then its job keeps the acts as read: the author not trusted, the label by the app
//   Scenario: a job of a source that judges no origin keeps none
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

async function boot(gh?: FakeGitHub) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = gh ? { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] } : undefined;
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, ...(gh ? { seams: { github: gh }, plugins } : {}) });
  apps.push(a);
  if (gh) connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobOf = (a: TestApp, url: string) => waitFor(async () =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url), { what: 'the job' });
const cardOf = async (a: TestApp, url: string): Promise<IntakeOutcome | undefined> =>
  ((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).find((x) => x.key === url);

describe('origin acts (issue #655, part 14)', () => {
  it('the user\'s own issue: its job keeps who wrote, labelled and assigned it, each trusted, and the stamp view says so', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'owner', body: body('Fix the typo.'), labels: ['hopper'] });
    await a.sync();
    const job = await jobOf(a, issue.url);
    const acts = [
      { role: 'author', login: 'owner', trusted: true },
      { role: 'labelled', login: 'owner', trusted: true },
      { role: 'assigned', login: 'owner', trusted: true },
    ];
    expect(job.source).toMatchObject({ origin: 'trusted', originActs: acts });
    expect(job.source!.originActs!.some((x) => 'app' in x)).toBe(false);
    expect((await a.api<StampView>('GET', `/api/jobs/${job.id}/stamp`)).body).toMatchObject({ level: 'owner', originActs: acts });
  });

  it('a request card a person approved: its job keeps the acts as read, the stranger not trusted and the app that labelled it', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body('Fix the typo.'), labels: ['hopper'], labelledBy: { login: 'owner', viaApp: 'cursor' }, assignedBy: 'owner' });
    await a.sync();
    const card = await cardOf(a, issue.url);
    expect(card).toMatchObject({ action: 'approve' });
    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [issue.url] } });
    const job = await jobOf(a, issue.url);
    expect(job.source).toMatchObject({
      origin: 'approved',
      originActs: [
        { role: 'author', login: 'stranger', trusted: false },
        { role: 'labelled', login: 'owner', app: 'cursor', trusted: false },
        { role: 'assigned', login: 'owner', trusted: true },
      ],
    });
    expect((await a.api<StampView>('GET', `/api/jobs/${job.id}/stamp`)).body).toMatchObject({ level: 'approved', originActs: job.source!.originActs });
  });

  it('a job of a source that judges no origin keeps no origin acts', async () => {
    const a = await boot();
    const j = await a.pull({ op: 'echo' });
    expect(j.source?.originActs).toBeUndefined();
    expect((await a.api<StampView>('GET', `/api/jobs/${j.id}/stamp`)).body.originActs).toBeNull();
  });
});
