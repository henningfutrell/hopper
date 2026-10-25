// The kept delivery tracks and deployment records (issue #2775, design.md "Kept delivery tracks") over the real HTTP server
// and database: GET /api/delivery-tracks answers each job's track as the kept-track pass kept it, GET /api/deployments the
// deployment records on their own, and a person flips a track's deployment expectation until its deployment completes.
//
// Feature: kept delivery tracks over the API
//   Scenario: a fix merged on the landing branch but not promoted shows as open in landing_checks, with what it waits on
//   Scenario: a research job's deployment record carries its source and outcome, and is listed on its own
//   Scenario: a person marks an open track no-deploy: it closes with a none record; again, 409; an unknown job, 404
//   Scenario: a none record flipped to deploy reopens its track, with every flip kept; the pass judges it again
//   Scenario: a completed deployment is locked: every flip is refused (409) and changes nothing
//   Scenario: a bad query is refused
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryTracksView, DeploymentsView, KeptTrack } from '../../src/domain/kept-tracks.ts';
import type { EventType } from '../../src/domain/types.ts';
import { keepDeliveryTracks } from '../../src/engine/kept-tracks.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const MIN = 60_000;
const REPO = 'octo/shed';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const t = Date.now() - 60 * MIN;
  const add = (type: EventType, at: number, data: Record<string, unknown>, jobId: string) =>
    a.user().store.events.append({ type, at: new Date(at).toISOString(), data, jobId });
  const queued = (id: string, n: number) => add('job.queued', t, { spec: { executor: 'test', payload: {}, priority: 50 }, priority: 50, source: { source: 'github', kind: 'issue', key: `k${n}`, repo: REPO, number: n } }, id);
  queued('fix', 1);
  add('job.started', t + MIN, { attempts: 1 }, 'fix');
  add('job.pull_request_followed', t + 2 * MIN, { pullRequest: pr(11), part: false }, 'fix');
  add('job.finished', t + 10 * MIN, { result: {} }, 'fix');
  add('job.pull_request_merged', t + 20 * MIN, { pullRequest: pr(11), part: false }, 'fix');
  queued('research', 2);
  add('job.started', t + MIN, { attempts: 1 }, 'research');
  add('job.finished', t + 5 * MIN, { result: {} }, 'research');
  keepDeliveryTracks(a.user().store, new Date());
  return { a, token: await a.login() };
}

const tracksOf = async (a: TestApp, q: string) => (await a.api<DeliveryTracksView>('GET', `/api/delivery-tracks?${q}`)).body.tracks;
const deploymentsOf = async (a: TestApp, q: string) => (await a.api<DeploymentsView>('GET', `/api/deployments?${q}`)).body.deployments;

describe('kept delivery tracks over the API', () => {
  it('a fix merged but not promoted is open in landing_checks; a finished job with no pull request closes with a none record', async () => {
    const { a } = await boot();
    const [fix] = await tracksOf(a, 'job=fix');
    expect(fix).toMatchObject({ jobId: 'fix', state: 'open', pullRequest: pr(11), current: { step: 'landing_checks', blocker: 'ci_red' } });
    expect(fix!.current.waitingOn).toMatch(/landing branch/);
    expect((await tracksOf(a, 'state=open')).map((t) => t.jobId)).toEqual(['fix']);
    // The research job here has no job row: its events say it finished, and its source is its issue.
    expect(await deploymentsOf(a, 'kind=none')).toEqual([
      { jobId: 'research', repo: REPO, at: expect.any(String), kind: 'none', source: `${REPO}#2`, outcome: { status: 'finished' } },
    ]);
    expect(await deploymentsOf(a, `repo=${encodeURIComponent(REPO)}&target=production`)).toEqual([]);
  });

  it('a person marks an open track no-deploy: it closes with a none record, once', async () => {
    const { a, token } = await boot();
    const r = await a.ui<KeptTrack>('/ui/api/delivery-tracks/no-deploy', { job: 'fix', note: 'a docs change' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'closed', deployment: { kind: 'none', source: `${REPO}#1`, outcome: { status: 'marked', by: expect.any(String), note: 'a docs change' } } });
    expect((await tracksOf(a, 'job=fix'))[0]!.state).toBe('closed');
    expect(await deploymentsOf(a, 'job=fix')).toHaveLength(1);
    expect(a.user().store.events.recent(5, ['delivery_track.no_deploy_marked'])).toHaveLength(1);
    // The pass leaves a closed none track as it was.
    keepDeliveryTracks(a.user().store, new Date());
    expect((await tracksOf(a, 'job=fix'))[0]).toEqual(r.body);
    expect((await a.ui('/ui/api/delivery-tracks/no-deploy', { job: 'fix' }, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/delivery-tracks/no-deploy', { job: 'nope' }, { token })).status).toBe(404);
  });

  it('a none record flipped to deploy reopens its track, with every flip kept; the pass judges it again', async () => {
    const { a, token } = await boot();
    const r = await a.ui<KeptTrack>('/ui/api/delivery-tracks/deploy', { job: 'research', note: 'ship the report' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'open', expectations: [{ expect: 'deploy', by: expect.any(String), note: 'ship the report' }], deployment: { kind: 'none' } });
    expect(a.user().store.events.recent(5, ['delivery_track.deploy_expected'])).toHaveLength(1);
    // The record stays, and says a person now expects a deployment.
    expect((await deploymentsOf(a, 'job=research'))[0]).toMatchObject({ kind: 'none', expectations: [{ expect: 'deploy' }] });
    keepDeliveryTracks(a.user().store, new Date());
    expect((await tracksOf(a, 'job=research'))[0]).toMatchObject({ state: 'open', expectations: [{ expect: 'deploy' }] });
    expect((await a.ui('/ui/api/delivery-tracks/deploy', { job: 'research' }, { token })).status).toBe(409);
    const back = await a.ui<KeptTrack>('/ui/api/delivery-tracks/no-deploy', { job: 'research' }, { token });
    expect(back.body).toMatchObject({ state: 'closed', expectations: [{ expect: 'deploy' }, { expect: 'none' }], deployment: { kind: 'none', outcome: { status: 'marked' } } });
    expect((await deploymentsOf(a, 'job=research'))[0]!.expectations).toHaveLength(2);
  });

  it('a completed deployment is locked: every flip is refused (409) and changes nothing', async () => {
    const { a, token } = await boot();
    const store = a.user().store;
    const kept = store.keptTracks.get('fix')!;
    const at = new Date().toISOString();
    const locked: KeptTrack = { ...kept, state: 'closed', closedAt: at, deployment: { jobId: 'fix', repo: REPO, at, kind: 'deploy', artifact: { pullRequest: pr(11) }, target: 'production', expected: 'delivered', observed: kept.steps } };
    store.keptTracks.save([locked]);
    for (const path of ['no-deploy', 'deploy']) expect((await a.ui(`/ui/api/delivery-tracks/${path}`, { job: 'fix' }, { token })).status).toBe(409);
    expect(store.keptTracks.get('fix')).toEqual(locked);
    // The store writes over neither a locked track nor its record.
    store.keptTracks.save([{ ...kept, state: 'open' }]);
    expect(store.keptTracks.get('fix')).toEqual(locked);
    expect((await deploymentsOf(a, 'job=fix'))[0]).toMatchObject({ kind: 'deploy' });
  });

  it('refuses a bad query (400)', async () => {
    const { a } = await boot();
    for (const q of ['repo=shed', 'state=done', 'limit=0', 'note=x']) expect((await a.api('GET', `/api/delivery-tracks?${q}`)).status).toBe(400);
    for (const q of ['kind=other', 'job=', 'x=1']) expect((await a.api('GET', `/api/deployments?${q}`)).status).toBe(400);
  });
});
