// Issue #945: search over Solr, from day one. The daemon, the store, the HTTP edge and Solr are real (test/support/solr.ts);
// OpenFGA is the in-memory double. A wrapper at the SearchIndex seam takes Solr down and brings it back.
//
// Feature: Search
//   Scenario: a job is written to the index from its events and found by its words, with highlights, facets and type-ahead
//   Scenario: a direct job's hit is private: its owner finds it, any other person does not; a job from GitHub is not private
//   Scenario: no secret is indexed: a token in a job's prompt finds nothing
//   Scenario: Solr down: search says degraded and why, the rest goes on, and the jobs changed meanwhile are written once it is back
//   Scenario: the first start with an index that lacks the user's jobs writes them all (the backfill); Reindex does it again
//   Scenario: Access that cannot be asked hides every hit, and says why
//   Scenario: with no Solr set up, search says it is not set up
//   Scenario: the operator CLI searches, suggests, reads the index's state and rebuilds it, on the same routes (part 2)
//   Scenario: an artifact is found by its title and its text, an infra plan by its summary; each links to its view (part 3)
//   Scenario: a removed artifact leaves the index; Reindex writes the artifacts and plans again too (part 3)
//   Scenario: an issue the issue graph keeps and a pull request linked to it are found by their words, an issue with what
//     intake did with it; each links to its job's view, else to itself (part 4)
//   Scenario: an agent with an API token searches on the same routes, as the CoS does (part 4)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import type { SearchAnswer, SearchIndex, SearchStatus, SuggestAnswer } from '../../src/domain/search.ts';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import { createSolrIndex } from '../../src/search/solr.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { JobSource } from '../../src/domain/ports.ts';
import { placeGraph } from '../../src/domain/issue-graph.ts';
import { createManualSource } from '../support/manual-source.ts';
import { rawRequest } from '../support/http.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startTestSolr, type TestSolr } from '../support/solr.ts';
import { databaseUrlFor } from '../support/database.ts';
import { KEY } from '../support/webhooks.ts';
import { waitFor } from '../support/wait.ts';

let solr: TestSolr;
beforeAll(async () => { solr = await startTestSolr(); }, 180_000);
afterAll(async () => { await solr?.stop(); });

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

/** Solr behind a switch: `down` makes every call fail as a Solr that cannot be reached. */
function switchable(inner: SearchIndex): SearchIndex & { down: boolean } {
  const s = { down: false } as SearchIndex & { down: boolean };
  const gate = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    if (s.down) throw new Error('Solr not reached: ECONNREFUSED');
    return f(...a);
  };
  return Object.assign(s, {
    ensureSchema: gate(inner.ensureSchema), put: gate(inner.put), remove: gate(inner.remove), count: gate(inner.count), search: gate(inner.search), suggest: gate(inner.suggest),
  });
}

async function start(o: { index?: SearchIndex | null; server?: FakeAuthorizationServer; db?: ReturnType<typeof tempDbPath>; sources?: JobSource[] } = {}) {
  const db = o.db ?? tempDbPath();
  if (!o.db) cleanups.push(db.cleanup);
  const index = o.index === undefined ? switchable(createSolrIndex({ url: solr.url })) : o.index;
  const app = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: o.server ?? createFakeAuthorizationServer(), searchIndex: index, ...(o.sources ? { sources: o.sources } : {}) } });
  apps.push(app);
  return { app, db, index };
}

const search = async (app: TestApp, query: string) => (await app.api<SearchAnswer>('GET', `/api/search?${query}`)).body;
const found = (app: TestApp, query: string, refs: (string | undefined)[], what = query) =>
  waitFor(async () => { const r = await search(app, query); return JSON.stringify(r.hits.map((h) => h.ref).sort()) === JSON.stringify(refs.map(String).sort()) ? r : undefined; }, { timeoutMs: 15_000, what });

describe('Search (issue #945)', () => {
  it('writes a job to the index from its events and finds it by its words, with highlights, facets and type-ahead', async () => {
    const { app } = await start();
    const job = await app.pull({ op: 'echo', message: 'the cache was cleared' }, { title: 'Clear the build cache', labels: ['infra'] });
    await app.waitForStatus(job.id, 'finished');
    const r = await found(app, 'q=cache%20cleared', [job.id]);
    expect(r).toMatchObject({ state: 'ok', total: 1, facets: { type: { job: 1 }, status: { finished: 1 }, labels: { infra: 1 } } });
    expect(r.hits[0]).toMatchObject({ type: 'job', ref: job.id, title: 'Clear the build cache', status: 'finished', labels: ['infra'], url: expect.stringContaining(`#job/${job.id}`) });
    expect(r.hits[0]!.highlights.result?.[0]).toContain('<mark>cleared</mark>');
    expect((await search(app, 'q=cache&status=failed')).hits).toEqual([]);
    expect((await search(app, 'q=cache&label=infra')).hits.map((h) => h.ref)).toEqual([job.id]);
    const s = (await app.api<SuggestAnswer>('GET', '/api/search/suggest?q=clea')).body;
    expect(s.suggestions).toEqual([{ type: 'job', ref: job.id, title: 'Clear the build cache', url: expect.stringContaining(`#job/${job.id}`) }]);
    expect((await app.api('GET', '/api/search?status=Not%20a%20status')).status).toBe(400);
    await waitFor(async () => { const st = (await app.api<SearchStatus>('GET', '/api/search/status')).body; return st.state === 'ok' && st.pending === 0; }, { timeoutMs: 15_000, what: 'nothing pending' });
  });

  it('keeps a direct job\'s hit private: its owner finds it, any other person does not', async () => {
    const server = createFakeAuthorizationServer();
    const { app } = await start({ server });
    const token = await app.login();
    const r = await app.ui<{ job: { id: string } }>('/ui/api/direct-jobs', { title: 'Unlock a sign-in', brief: '{"op":"echo","message":"done"}\nClear the lockout.', labels: ['sme:identity'], executor: 'scripted' }, { token });
    const github = await app.pull({ op: 'echo', message: 'done' }, { title: 'Clear the lockout docs' });
    await found(app, 'q=lockout', [r.body.job.id, github.id]);
    const other = await app.user(ADMIN_ID).search.search('someone-else', { text: 'lockout', limit: 10, offset: 0 });
    expect(other.hits.map((h) => h.ref)).toEqual([github.id]);
    // Asked of OpenFGA, the owner and the readers told for that check only.
    expect(server.checks.some((c) => c.tuple.relation === 'can_view' && c.tuple.object.startsWith(`search_hit:${ADMIN_ID}/job/`))).toBe(true);
  });

  it('indexes no secret: a token in a job\'s prompt finds nothing', async () => {
    const { app } = await start();
    const secret = `ghp_${'b'.repeat(36)}`;
    const job = await app.pull({ op: 'echo', message: 'ok' }, { title: 'Rotate the deploy key', prompt: `use ${secret} to push` });
    await found(app, 'q=rotate', [job.id]);
    expect((await search(app, `q=${secret}`)).hits).toEqual([]);
  });

  it('says degraded while Solr is down, and writes the jobs changed meanwhile once it is back', async () => {
    const { app, index } = await start();
    const s = index as SearchIndex & { down: boolean };
    const first = await app.pull({ op: 'echo', message: 'one' }, { title: 'First job' });
    await found(app, 'q=first', [first.id]);
    s.down = true;
    const r = await search(app, 'q=first');
    expect(r).toMatchObject({ state: 'degraded', why: 'Solr not reached: ECONNREFUSED', hits: [] });
    const second = await app.pull({ op: 'echo', message: 'two' }, { title: 'Second job' });
    await app.waitForStatus(second.id, 'finished');
    expect((await app.api<SearchStatus>('GET', '/api/search/status')).body.pending).toBeGreaterThan(0);
    expect((await app.api('GET', '/api/jobs')).status).toBe(200);
    s.down = false;
    await found(app, 'q=second', [second.id], 'the job written once Solr is back');
    await waitFor(async () => (await app.api<SearchStatus>('GET', '/api/search/status')).body.state === 'ok', { timeoutMs: 70_000, what: 'search ok again' });
  }, 90_000);

  it('writes every job of a user the index lacks at the first start (the backfill), and again on Reindex', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const before = (await start({ index: null, db })).app;
    const job = await before.pull({ op: 'echo', message: 'kept' }, { title: 'Made before search' });
    await before.waitForStatus(job.id, 'finished');
    expect((await search(before, 'q=made')).state).toBe('not-configured');
    await before.stop(); apps.splice(apps.indexOf(before), 1);

    const { app } = await start({ db });
    await found(app, 'q=made', [job.id], 'the backfilled job');
    expect((await app.api<SearchStatus>('GET', '/api/search/status')).body.backfill).toMatchObject({ done: true });
    const token = await app.login();
    const r = await app.ui<{ marked: number; status: SearchStatus }>('/ui/api/search/reindex', {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.marked).toBe(1);
    await waitFor(async () => (await app.api<SearchStatus>('GET', '/api/search/status')).body.backfill?.done === true, { timeoutMs: 15_000, what: 'reindex done' });
  });

  it('hides every hit while Access cannot be asked, and says why', async () => {
    const server = createFakeAuthorizationServer();
    const { app } = await start({ server });
    const job = await app.pull({ op: 'echo', message: 'x' }, { title: 'Guarded job' });
    await found(app, 'q=guarded', [job.id]);
    server.reachable = false;
    const r = await waitFor(async () => { const a = await search(app, 'q=guarded'); return a.state === 'degraded' ? a : undefined; }, { what: 'degraded by Access' });
    expect(r.hits).toEqual([]);
    expect(r.why).toMatch(/OpenFGA cannot be asked/);
  });

  it('searches, suggests, reads the index\'s state and rebuilds it from the operator CLI, on the same routes', async () => {
    const { app } = await start();
    const hopper = async (argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
      const code = await runCli([...argv, '--url', app.url], io);
      return { code, out: out.join(''), err: err.join('') };
    };
    const job = await app.pull({ op: 'echo', message: 'the cache was cleared' }, { title: 'Clear the build cache', labels: ['infra'] });
    const other = await app.pull({ op: 'echo', message: 'warm' }, { title: 'Warm the cache', labels: ['ops'] });
    await found(app, 'q=cache', [job.id, other.id]);

    const r = await hopper(['search', 'build', 'cache', '--label', 'infra', '--status', 'finished']);
    expect(r).toMatchObject({ code: 0, err: '' });
    const a = JSON.parse(r.out) as SearchAnswer;
    expect(a.state).toBe('ok');
    expect(a.hits.map((h) => h.ref)).toEqual([job.id]);
    expect(JSON.parse((await hopper(['search', 'cache', '--label', 'ops'])).out).hits.map((h: { ref: string }) => h.ref)).toEqual([other.id]);
    expect(JSON.parse((await hopper(['search', 'cache', '--limit', '1'])).out).hits).toHaveLength(1);

    const s = JSON.parse((await hopper(['search', '--suggest', 'clea'])).out) as SuggestAnswer;
    expect(s.suggestions.map((x) => x.ref)).toEqual([job.id]);

    expect(JSON.parse((await hopper(['search', '--index'])).out)).toMatchObject({ state: 'ok' });
    const re = await hopper(['search', '--reindex']);
    expect(re.code).toBe(0);
    expect(JSON.parse(re.out)).toMatchObject({ marked: 2 });

    const bad = await hopper(['search', 'cache', '--status', 'Not a status']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/refused \(400\)/);
    const both = await hopper(['search', '--suggest', 'x', '--reindex']);
    expect(both.code).toBe(2);
    expect(both.err).toMatch(/usage: hopper search/);
  });

  it('finds an artifact by its title and its text, and an infra plan by its summary, each with a link to its view (part 3)', async () => {
    const { app } = await start();
    const job = await app.pull({ op: 'echo', message: 'done' }, { title: 'Write the outage report' });
    await app.waitForStatus(job.id, 'finished');
    const rt = app.user(ADMIN_ID);
    const put = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'report.md', title: 'Outage report', summary: 'What broke on Monday', content: Buffer.from('# Outage\n\nThe resolver timed out under load.') });
    if ('no' in put) throw new Error(put.no);
    const plan: InfraPlan = {
      id: '00000000-0000-4000-8000-000000000001', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network', repo: 'o/infra', ref: 'issue-1',
      commit: 'a'.repeat(40), text: 'resource "aws_security_group_rule" "hidden_rule" {}', job: job.id, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
      summary: { words: 'Adds 1 security group rule in uat', level: 'low', counts: { create: 1, update: 0, replace: 0, delete: 0 }, environments: ['uat'], risks: [], blastRadius: 'one rule in uat', checks: [], failed: false },
    };
    rt.store.tx(() => {
      rt.store.infraPlans.add(plan);
      rt.store.events.append({ type: 'infra.plan_recorded', jobId: job.id, data: {
        plan: plan.id, tool: plan.tool, asset: plan.asset, target: plan.target, repo: plan.repo, ref: plan.ref, commit: plan.commit, file: false, expiresAt: plan.expiresAt,
        summary: { words: plan.summary!.words, level: 'low', risks: [], failed: false },
      } });
    });

    const byText = await found(app, 'q=resolver', [put.id], 'the artifact by its text');
    expect(byText.hits[0]).toMatchObject({ type: 'artifact', ref: put.id, title: 'Outage report', job: job.id, url: expect.stringContaining(`#artifacts/${put.id}`) });
    expect(byText.hits[0]!.highlights.content?.[0]).toContain('<mark>resolver</mark>');
    await found(app, 'q=outage&type=artifact', [put.id]);
    const r = await found(app, 'q=outage', [job.id, put.id]);
    expect(r.facets.type).toEqual({ job: 1, artifact: 1 });

    const p = await found(app, 'q=security%20group', [plan.id], 'the plan by its summary');
    expect(p.hits[0]).toMatchObject({ type: 'infra-plan', status: 'recorded', repo: 'o/infra', job: job.id, url: expect.stringContaining('#infra') });
    expect((await search(app, 'q=hidden_rule')).hits).toEqual([]);
    rt.store.tx(() => {
      rt.store.infraPlans.approve({ plan: plan.id, by: 'octo', at: new Date().toISOString() });
      rt.store.events.append({ type: 'infra.plan_approved', jobId: job.id, data: { plan: plan.id, tool: plan.tool, asset: plan.asset, target: plan.target, by: 'octo' } });
    });
    await found(app, 'q=security&status=approved', [plan.id], 'the plan approved');
    expect((await app.api<SuggestAnswer>('GET', '/api/search/suggest?q=outa')).body.suggestions.map((x) => x.type).sort()).toEqual(['artifact', 'job']);
  }, 60_000); // A job run and six index waits: past 15 s on a loaded CI shard, as part 4's (issue #2268).

  it('takes a removed artifact out of the index, and writes the artifacts and plans again on Reindex (part 3)', async () => {
    const { app } = await start();
    const job = await app.pull({ op: 'echo', message: 'ok' }, { title: 'Draw the graph' });
    await app.waitForStatus(job.id, 'finished');
    const rt = app.user(ADMIN_ID);
    const put = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'notes.txt', title: 'Graph notes', content: Buffer.from('the axis is logarithmic') });
    if ('no' in put) throw new Error(put.no);
    await found(app, 'q=logarithmic', [put.id]);
    const token = await app.login();
    const re = await app.ui<{ marked: number }>('/ui/api/search/reindex', {}, { token });
    expect(re.body.marked).toBe(2);
    rt.artifacts.remove(put.id, 'octo');
    await found(app, 'q=logarithmic', [], 'the removed artifact gone');
  });

  it('finds an issue the issue graph keeps and a pull request linked to it, with what intake did, each linked to its job or itself (part 4)', async () => {
    const ISSUE = 'https://github.com/o/r/issues/7', OTHER = 'https://github.com/o/r/issues/8', PR = 'https://github.com/o/r/pull/9';
    const outcomes: IntakeOutcome[] = [{ key: OTHER, title: 'Rotate the backup keys', repo: 'o/r', reason: 'not assigned to you', group: 'not-assigned', action: 'assign' }];
    const gh = Object.assign(createManualSource('gh'), { intake: () => outcomes });
    const { app } = await start({ sources: [gh] });
    await app.user(ADMIN_ID).sources.syncNow('gh');
    const rt = app.user(ADMIN_ID);
    const at = new Date().toISOString();
    rt.store.issueGraph.record(ISSUE, placeGraph({
      issue: { repo: 'o/r', number: 7, url: ISSUE, title: 'Retry the flaky upload', state: 'OPEN', updatedAt: at }, owner: { login: 'o' }, projects: [],
      closedBy: [{ kind: 'pull_request', repo: 'o/r', number: 9, url: PR, state: 'MERGED' }], references: [], subIssues: [],
    }), at);
    rt.store.issueGraph.record(OTHER, placeGraph({
      issue: { repo: 'o/r', number: 8, url: OTHER, title: 'Rotate the backup keys', state: 'OPEN', updatedAt: at }, owner: { login: 'o' }, projects: [],
      closedBy: [], references: [], subIssues: [],
    }), at);
    rt.search.reindex();
    await found(app, 'q=flaky&type=issue', [ISSUE], 'the issue before its job');
    // Its job's events write the issue again, and the pull request that closes it: each now names the job.
    const job = await app.pull({ op: 'echo', message: 'done' }, { key: ISSUE, title: 'Retry the flaky upload', repo: 'o/r' });
    await app.waitForStatus(job.id, 'finished');
    await waitFor(async () => (await search(app, 'q=flaky&type=issue')).hits[0]?.job === job.id || undefined, { timeoutMs: 15_000, what: 'the issue written again with its job' });

    const issue = await found(app, 'q=flaky&type=issue', [ISSUE], 'the issue by its title');
    expect(issue.hits[0]).toMatchObject({ type: 'issue', title: 'Retry the flaky upload', status: 'open', repo: 'o/r', job: job.id, url: expect.stringContaining(`#job/${job.id}`) });
    const pr = await found(app, 'q=flaky&type=pull-request', [PR], 'the pull request by the issue it closes');
    expect(pr.hits[0]).toMatchObject({ title: 'o/r#9', status: 'merged', job: job.id, url: expect.stringContaining(`#job/${job.id}`) });
    expect(pr.hits[0]!.highlights.links?.[0]).toContain('<mark>flaky</mark>');
    expect((await found(app, 'q=flaky', [job.id, ISSUE, PR])).facets.type).toEqual({ job: 1, issue: 1, 'pull-request': 1 });

    const other = await found(app, 'q=assigned', [OTHER], 'the intake item by why it was not taken');
    expect(other.hits[0]).toMatchObject({ type: 'issue', title: 'Rotate the backup keys', url: OTHER });
    expect(other.hits[0]!.highlights.intake?.[0]).toContain('<mark>assigned</mark>');
    outcomes[0] = { key: OTHER, title: 'Rotate the backup keys', repo: 'o/r', reason: 'on the backburner', group: 'backburner', action: 'unbackburner' };
    // The source's status keeps a copy of its intake from its last sync (with each item's arrival), so a sync reads it.
    await rt.sources.syncNow('gh');
    rt.store.events.append({ type: 'source.request_opened', data: { source: 'gh', key: OTHER, hash: 'a'.repeat(64), author: 'someone', why: ['not a trusted actor'] } });
    await found(app, 'q=backburner', [OTHER], 'the intake item written again after an intake event');
    expect((await app.api<SuggestAnswer>('GET', '/api/search/suggest?q=rota')).body.suggestions).toEqual([{ type: 'issue', ref: OTHER, title: 'Rotate the backup keys', url: OTHER }]);
  }, 60_000); // A job run and eight index waits: about 8 s alone, past 15 s on a loaded CI shard (issue #2268).

  it('answers an agent with an API token on the same routes, as it answers the UI and the CLI (part 4: the CoS)', async () => {
    const { app } = await start();
    const job = await app.pull({ op: 'echo', message: 'the certificate was renewed' }, { title: 'Renew the certificate' });
    await app.waitForStatus(job.id, 'finished');
    await found(app, 'q=certificate', [job.id]);
    const minted = await app.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'cos', scopes: ['*:read'] }, { token: await app.login() });
    expect(minted.status).toBe(200);
    const r = await rawRequest(app.url, { path: '/api/search?q=certificate', headers: { authorization: `Bearer ${minted.body.token}` } });
    expect(r.status).toBe(200);
    expect((JSON.parse(r.text) as SearchAnswer).hits.map((h) => h.ref)).toEqual([job.id]);
    const s = await rawRequest(app.url, { path: '/api/search/suggest?q=renew', headers: { authorization: `Bearer ${minted.body.token}` } });
    expect((JSON.parse(s.text) as SuggestAnswer).suggestions.map((x) => x.ref)).toEqual([job.id]);
  });
});
