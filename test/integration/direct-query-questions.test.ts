// Issue #2184, part 2: a direct query's question that reaches a person goes to the caller's callback too, not only to
// Questions and the notifiers. The caller answers it with its own API token, and the job goes on to the answer. The
// daemon, store, HTTP edge and webhook receiver are real; the executor is the scripted one.
//
// Feature: Direct queries
//   Scenario: a direct query's job asks a question, and the callback gets it
//     Given a webhook subscription "grok-bot"
//     When the caller asks a question whose job asks "Which cluster do you mean?"
//     Then grok-bot gets direct_query.question_asked with the question, its id and where to answer it, signed
//     And the query reads back as waiting
//     When the caller answers the question with its API token
//     Then grok-bot gets direct_query.answered
//   Scenario: a direct job's question is not a direct query's: no direct_query event
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

async function start(): Promise<{ app: TestApp; token: string; box: string; rx: Receiver }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY } });
  apps.push(app);
  const token = await app.login();
  const rx = await startReceiver();
  cleanups.push(rx.close);
  expect((await app.ui('/ui/api/webhooks', { action: 'add', name: 'grok-bot', url: rx.url, events: ['source.stalled'], secret: ENTERED }, { token })).status).toBe(200);
  const box = (await app.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'grok', scopes: ['*'], box: true }, { token })).body.token;
  return { app, token, box, rx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
async function post(a: TestApp, token: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await rawRequest(a.url, { method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
}

const ASKED = 'Which cluster do you mean? This is hard.';
const callbacks = (rx: Receiver) => rx.received.map((r) => ({ type: r.headers['x-hopper-event'], event: JSON.parse(r.body) as DomainEvent, ok: r.headers['x-hopper-signature'] === signatureOf(ENTERED, r) }));
const eventsOf = (a: TestApp, prefix: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type.startsWith(prefix));

describe('Direct query questions (issue #2184, part 2)', () => {
  it('sends a question that reaches a person to the callback; the caller answers it, and the answer follows', async () => {
    const { app, box, rx } = await start();
    const r = await post(app, box, '/ui/api/direct-queries', {
      requestId: 'r-7', question: `${JSON.stringify({ op: 'ask', message: ASKED })}\nWhere does the otel collector run?`, callback: 'grok-bot', executor: 'scripted',
    });
    expect(r.status).toBe(200);
    const id = (r.body.directQuery as DirectQueryView).id;

    const asked = await waitFor(() => callbacks(rx).find((c) => c.type === 'direct_query.question_asked'), { what: 'the question callback' });
    expect(asked.ok).toBe(true);
    const data = asked.event.data as { questionId: string; question: string; answerUrl: string };
    expect(asked.event.data).toMatchObject({ id, requestId: 'r-7', jobId: r.body.job.id, questionId: expect.any(String), callback: 'grok-bot', url: expect.any(String) });
    expect(data.question).toContain('Which cluster');
    expect(data.answerUrl).toContain(data.questionId);
    expect((await app.api<DirectQueryView>('GET', '/api/direct-queries/r-7')).body.state).toBe('waiting');

    expect((await post(app, box, `/ui/api/questions/${data.questionId}/answer`, { answer: 'the observability cluster' })).status).toBe(200);
    await waitFor(() => callbacks(rx).find((c) => c.type === 'direct_query.answered'), { what: 'the answer callback' });
    expect(eventsOf(app, 'direct_query.question_asked')).toHaveLength(1);
  });

  it('sends no direct_query event for a direct job\'s question', async () => {
    const { app, token } = await start();
    const made = await app.ui<{ job: { id: string } }>('/ui/api/direct-jobs', { title: 'Unlock', brief: `${JSON.stringify({ op: 'ask', message: ASKED })}\nUnlock it.`, labels: [], authorizations: [], executor: 'scripted' }, { token });
    expect(made.status).toBe(200);
    await waitFor(() => (eventsOf(app, 'question.escalated_to_human').length > 0 ? true : undefined), { what: 'the question' });
    expect(eventsOf(app, 'direct_query.')).toEqual([]);
  });
});
