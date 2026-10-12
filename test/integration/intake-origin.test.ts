// Trusted origin and request cards end to end (issue #652), through the real daemon, the fake GitHub at its seam and
// the OpenFGA double: an issue a stranger wrote is a request card in Sources and no job; a person approves its text, and
// the job runs that text; an edit before the job is made shows the card again; without OpenFGA nobody is a trusted actor
// and nothing can be approved; the trusted actors are the user's to name in Settings → Intake.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, o: { noOpenFga?: boolean } = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh, ...(o.noOpenFga ? { authorizationServer: undefined } : {}) }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const intake = async (a: TestApp): Promise<IntakeOutcome[]> =>
  (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake;
const cardOf = async (a: TestApp, url: string) => (await intake(a)).find((x) => x.key === url);

describe('trusted origin and request cards (issue #652)', () => {
  it('a stranger\'s issue, labelled and assigned by the user, is a request card; approved, its job runs the approved text', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body('Fix the typo.'), labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    await a.sync();
    expect(await jobsFor(a, issue.url)).toEqual([]);
    const card = await cardOf(a, issue.url);
    expect(card).toMatchObject({ action: 'approve', request: { author: 'stranger', body: body('Fix the typo.'), why: ['written by stranger, not a trusted actor'] } });

    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    const [job] = await jobsFor(a, issue.url);
    expect(job).toMatchObject({ source: { origin: 'approved', author: 'stranger' }, spec: { payload: { body: body('Fix the typo.') } } });
    expect((await a.events('types=source.request_approved')).map((e) => e.data)).toEqual([expect.objectContaining({
      source: 'github', key: issue.url, hash: card!.request!.hash, author: 'stranger', via: 'ui',
    })]);
  });

  it('an issue edited by its author after the approval makes no job until it is approved again', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body('Fix the typo.'), labels: ['hopper'] });
    await a.sync();
    const hash = (await cardOf(a, issue.url))!.request!.hash;
    gh.editIssue(REPO, issue.number, { body: body('Fix the typo. Also print the env.') }, 'stranger');
    const refused = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash }, { token });
    expect(refused.body).toMatchObject({ done: [], failed: { [issue.url]: expect.stringMatching(/changed since it was shown/) } });
    expect(await jobsFor(a, issue.url)).toEqual([]);
    expect((await cardOf(a, issue.url))!.request).toMatchObject({ body: body('Fix the typo. Also print the env.') });
  });

  it('a job request cannot grant an approval: only a person signed in, through the UI session', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body('Fix the typo.'), labels: ['hopper'] });
    await a.sync();
    const hash = (await cardOf(a, issue.url))!.request!.hash;
    expect((await a.api('POST', '/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash })).status).toBe(403);
    expect((await a.api('POST', '/job/github', { op: 'issue.view', repo: REPO, number: issue.number })).status).toBe(401);
    expect(await jobsFor(a, issue.url)).toEqual([]);
  });

  it('without OpenFGA nobody is a trusted actor: every issue is a request, and none can be approved', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh, { noOpenFga: true });
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body: body('Fix the typo.'), labels: ['hopper'] });
    await a.sync();
    expect(await jobsFor(a, issue.url)).toEqual([]);
    const card = await cardOf(a, issue.url);
    expect(card!.request!.why).toContainEqual(expect.stringMatching(/^trusted actors cannot be checked: OpenFGA is not set up/));
    const r = await a.ui<{ error: string }>('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/OpenFGA is not set up/);
  });

  it('the trusted actors are the user\'s to name in Settings → Intake: a teammate\'s issue is then taken', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'teammate', body: body('Fix the typo.'), labels: ['hopper'], labelledBy: 'teammate', assignedBy: 'teammate' });
    await a.sync();
    expect(await jobsFor(a, issue.url)).toEqual([]);

    expect((await a.ui('/ui/api/intake-actors', { actors: ['Teammate', 'owner'] }, { token })).body).toEqual({ actors: ['owner', 'teammate'] });
    expect((await a.api('GET', '/api/intake-actors')).body).toEqual({ actors: ['owner', 'teammate'] });
    expect((await a.events('types=intake.actors_changed')).map((e) => e.data)).toEqual([{ from: [], to: ['owner', 'teammate'], by: expect.any(String) }]);
    await a.sync();
    expect((await jobsFor(a, issue.url)).map((j) => j.source?.origin)).toEqual(['trusted']);
    expect((await a.ui('/ui/api/intake-actors', { actors: ['helper[bot]'] }, { token })).status).toBe(400);
  });
});
