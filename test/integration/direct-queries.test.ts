// Issue #2184: a direct query. A caller — an agent with a box token a person minted — asks the hopper a question straight,
// with no GitHub issue, and names a webhook subscription as its callback. A job that only looks answers it, and the
// subscription gets the answer, signed with its own secret, as a delivery kept and retried as every delivery is. The
// daemon, store, HTTP edge and webhook receiver are real; the executor is the scripted one.
//
// Feature: Direct queries
//   Scenario: a caller asks a question, a look-only job answers it, and the callback gets the answer
//     Given a webhook subscription "grok-bot" that lists no direct_query event
//     When the caller asks "where does the otel collector run?" with callback grok-bot
//     Then its job is queued from the source direct, labelled direct:query, look-only, with no repository
//     And grok-bot gets direct_query.accepted, then direct_query.answered with the answer, both signed with its secret
//     And the query reads back by its request id as answered, and no GitHub issue or proxy call was made
//   Scenario: the same request id again answers the query kept; with another question it is a conflict
//   Scenario: a failed query's callback says why
//   Scenario: a change, an unknown callback, and an API token that is no box token are refused, and nothing is kept
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import type { DirectQueryView } from '../../src/domain/direct-jobs.ts';
import { rawRequest } from '../support/http.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { ENTERED, KEY, signatureOf } from '../support/webhooks.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start(): Promise<{ app: TestApp; box: string; plain: string; rx: Receiver }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY } });
  apps.push(app);
  const token = await app.login();
  const rx = await startReceiver();
  cleanups.push(rx.close);
  expect((await app.ui('/ui/api/webhooks', { action: 'add', name: 'grok-bot', url: rx.url, events: ['source.stalled'], secret: ENTERED }, { token })).status).toBe(200);
  const mint = async (box: boolean) => (await app.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'grok', scopes: ['*'], box }, { token })).body.token;
  return { app, box: await mint(true), plain: await mint(false), rx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
async function ask(a: TestApp, token: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await rawRequest(a.url, { method: 'POST', path: '/ui/api/direct-queries', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
}

const QUESTION = 'Where does the otel collector run?';
const question = (op: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  requestId: 'r-42', question: `${JSON.stringify(op)}\n${QUESTION}`, callback: 'grok-bot', repos: ['octo-org/infra'], executor: 'scripted', ...more,
});
const eventsOf = (a: TestApp, prefix: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type.startsWith(prefix));
const callbacks = (rx: Receiver) => rx.received.map((r) => ({ type: r.headers['x-hopper-event'], event: JSON.parse(r.body) as DomainEvent, ok: r.headers['x-hopper-signature'] === signatureOf(ENTERED, r) }));

describe('Direct queries (issue #2184)', () => {
  it('answers a question with a look-only job, and the callback gets the answer, signed', async () => {
    const { app, box, rx } = await start();
    const r = await ask(app, box, question({ op: 'echo', message: 'the otel-collector deployment in the observability namespace' }));
    expect(r.status).toBe(200);
    const { directQuery, job } = r.body as { directQuery: DirectQueryView; job: { id: string; source: Record<string, unknown> } };
    expect(directQuery).toMatchObject({ query: { requestId: 'r-42', callback: 'grok-bot', repos: ['octo-org/infra'] }, labels: ['direct:query'], authorizations: [], submittedBy: { via: 'api' } });
    expect(job.source).toMatchObject({ source: 'direct', key: `direct:${directQuery.id}`, labels: ['direct:query'] });
    expect(job.source.repo).toBeUndefined();
    expect(((await app.job(job.id)).spec.payload as { env: Record<string, string> }).env.HOPPER_DIRECT_QUERY).toBe(directQuery.id);

    const got = await waitFor(() => (rx.received.length >= 2 ? callbacks(rx) : undefined), { what: 'the callbacks' });
    expect(got.map((c) => c.type)).toEqual(['direct_query.accepted', 'direct_query.answered']);
    expect(got.every((c) => c.ok)).toBe(true);
    expect(got[0]!.event.data).toEqual({ id: directQuery.id, requestId: 'r-42', by: expect.any(String), via: 'api', callback: 'grok-bot' });
    expect(JSON.stringify(got[0]!.event.data)).not.toContain(QUESTION);
    expect(got[1]!.event).toMatchObject({ jobId: job.id, data: { id: directQuery.id, requestId: 'r-42', jobId: job.id, answer: { echo: 'the otel-collector deployment in the observability namespace' }, artifacts: [], callback: 'grok-bot' } });

    const back = (await app.api<DirectQueryView>('GET', '/api/direct-queries/r-42')).body;
    expect(back).toMatchObject({ id: directQuery.id, state: 'answered', job: { id: job.id, status: 'finished' } });
    expect((await app.api<{ directQueries: DirectQueryView[] }>('GET', '/api/direct-queries')).body.directQueries.map((q) => q.id)).toEqual([directQuery.id]);
    expect((await app.api('GET', '/api/direct-queries/r-none')).status).toBe(404);
    // No issue behind it, and nothing asked of GitHub.
    expect(eventsOf(app, 'github_proxy.')).toEqual([]);
    expect((await app.job(job.id)).source).not.toHaveProperty('number');
  });

  it('answers the same request id with the query kept, and refuses it with another question', async () => {
    const { app, box, rx } = await start();
    const first = await ask(app, box, question({ op: 'echo', message: 'one' }));
    const again = await ask(app, box, question({ op: 'echo', message: 'one' }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, directQuery: { id: first.body.directQuery.id } });
    expect(again.body.job).toBeUndefined();
    expect((await ask(app, box, question({ op: 'echo', message: 'two' }))).status).toBe(409);
    await waitFor(() => (rx.received.length >= 2 ? true : undefined), { what: 'the callbacks' });
    expect(eventsOf(app, 'direct_query.accepted')).toHaveLength(1);
    expect(app.user(ADMIN_ID).store.jobs.list({}).filter((j) => j.source?.source === 'direct')).toHaveLength(1);
  });

  it('tells the callback why a query failed', async () => {
    const { app, box, rx } = await start();
    await ask(app, box, question({ op: 'fail', message: 'HOPPER_FAILED the answer needs a change: file an issue' }));
    const got = await waitFor(() => callbacks(rx).find((c) => c.type === 'direct_query.failed'), { what: 'the failed callback' });
    expect(got.ok).toBe(true);
    expect(got.event.data).toMatchObject({ requestId: 'r-42', error: expect.stringContaining('needs a change') });
    expect((await app.api<DirectQueryView>('GET', '/api/direct-queries/r-42')).body.state).toBe('failed');
  });

  it('refuses a change, an unknown callback, and an API token that is no box token, and keeps nothing', async () => {
    const { app, box, plain } = await start();
    const change = await ask(app, box, question({ op: 'echo' }, { mode: 'change' }));
    expect(change.status).toBe(422);
    expect(change.body.error).toMatch(/only looks/);
    expect((await ask(app, box, question({ op: 'echo' }, { callback: 'nobody' }))).status).toBe(400);
    const notBox = await ask(app, plain, question({ op: 'echo' }));
    expect(notBox.status).toBe(403);
    expect(notBox.body.error).toMatch(/box action/);
    expect((await app.api('GET', '/api/direct-queries')).body.directQueries).toEqual([]);
    expect(eventsOf(app, 'direct_query.')).toEqual([]);
  });
});
