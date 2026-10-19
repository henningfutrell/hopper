// The backfill of trusted origin (issue #652, requirement 10), through the real daemon, the fake GitHub at its seam and
// the OpenFGA double: a job queued before origins were judged (tenant migration 39 marks it `originPending`) does not
// start; the next sync judges its issue. Of a trusted origin, it gets that origin and runs; any other issue is a request
// card in Sources, and its job stays held until a person approves the card. A job made from an item offered with no
// origin (issue #2113: its issue's job had not ended when the sync judged origins) waits for it the same way.
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_PENDING } from '../../src/decider/index.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const BODY = '{"op":"fail","message":"the queued text ran"}';
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

/** A job of the issue as one queued before origins were judged is after tenant migration 39: no origin, pending. */
function queuedBefore(a: TestApp, issue: { url: string; number: number; title: string; author: string }): Job {
  const { store } = a.user();
  return store.tx(() => {
    const job = store.jobs.create(
      { executor: 'scripted', payload: { prompt: BODY, body: BODY, env: {} }, goal: issue.title, priority: 50, submittedBy: `github:${issue.author}`, kind: 'coding' },
      50,
      { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, title: issue.title, repo: REPO, number: issue.number, author: issue.author, labels: ['hopper'] },
    );
    return store.jobs.update(job.id, { originPending: true });
  });
}

const job = async (a: TestApp, id: string) => (await a.api<Job>('GET', `/api/jobs/${id}`)).body;
const cardOf = async (a: TestApp, url: string): Promise<IntakeOutcome | undefined> =>
  ((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).find((x) => x.key === url);

describe('the backfill of trusted origin (issue #652)', () => {
  it('a queued job of a trusted issue gets its origin at the next sync, and runs', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: BODY, labels: ['hopper'] });
    const queued = queuedBefore(a, issue);
    await a.sync();
    const ran = await a.waitForStatus(queued.id, 'failed');
    expect(ran).toMatchObject({ source: { origin: 'trusted' }, error: 'the queued text ran' });
    expect(ran.originPending).toBeUndefined();
    expect((await a.events('types=job.origin_judged')).map((e) => [e.jobId, e.data])).toEqual([[queued.id, { key: issue.url, origin: 'trusted' }]]);
  });

  it('a queued job of a stranger\'s issue is held, its issue a request card; approved, the job runs', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: BODY, labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    const queued = queuedBefore(a, issue);
    await a.sync();
    const held = await waitFor(async () => { const j = await job(a, queued.id); return j.holdReason === ORIGIN_PENDING ? j : undefined; }, { what: 'held for its origin' });
    expect(held).toMatchObject({ status: 'held', originPending: true });
    expect(held.source?.origin).toBeUndefined();
    const card = await cardOf(a, issue.url);
    expect(card).toMatchObject({ action: 'approve', request: { author: 'stranger', why: ['written by stranger, not a trusted actor'] } });
    // A second sync changes nothing: the job stays held, no second job is made.
    await a.sync();
    expect((await job(a, queued.id)).status).toBe('held');
    expect((await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url)).toHaveLength(1);

    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    const ran = await a.waitForStatus(queued.id, 'failed');
    expect(ran).toMatchObject({ source: { origin: 'approved' }, error: 'the queued text ran' });
    expect(ran.originPending).toBeUndefined();
    expect((await a.events('types=job.origin_judged')).map((e) => e.data)).toEqual([{ key: issue.url, origin: 'approved' }]);
  });

  it('a job made from an item offered with no origin waits for it (issue #2113); its card approved, it runs', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: BODY, labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    const made = a.user().engine.sourceHost.ingest({
      key: issue.url, url: issue.url, title: issue.title, body: BODY, prompt: BODY, env: {}, author: 'stranger', priority: 50,
      priorityReason: 'default', labels: ['hopper'], repo: REPO, number: issue.number, executor: 'scripted',
    }, { name: 'github', kind: 'github-account' })!;
    expect(made).toMatchObject({ originPending: true, stamp: { level: 'untrusted', reasons: ['origin:none'] } });
    await a.sync();
    const held = await waitFor(async () => { const j = await job(a, made.id); return j.holdReason === ORIGIN_PENDING ? j : undefined; }, { what: 'held for its origin' });
    expect(held).toMatchObject({ status: 'held', originPending: true });
    const card = await cardOf(a, issue.url);
    expect(card).toMatchObject({ action: 'approve', request: { author: 'stranger' } });

    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    const ran = await a.waitForStatus(made.id, 'failed');
    expect(ran).toMatchObject({ source: { origin: 'approved' }, stamp: { reasons: ['origin:approved'] }, error: 'the queued text ran' });
    expect(ran.originPending).toBeUndefined();
  });
});
