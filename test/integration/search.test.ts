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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import type { SearchAnswer, SearchIndex, SearchStatus, SuggestAnswer } from '../../src/domain/search.ts';
import { createSolrIndex } from '../../src/search/solr.ts';
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

async function start(o: { index?: SearchIndex | null; server?: FakeAuthorizationServer; db?: ReturnType<typeof tempDbPath> } = {}) {
  const db = o.db ?? tempDbPath();
  if (!o.db) cleanups.push(db.cleanup);
  const index = o.index === undefined ? switchable(createSolrIndex({ url: solr.url })) : o.index;
  const app = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: o.server ?? createFakeAuthorizationServer(), searchIndex: index } });
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
});
