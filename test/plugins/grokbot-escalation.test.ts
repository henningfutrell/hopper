// The Grok Bot routine hears a question once, when it reaches the human (issue #481): it listens to
// `question.escalated_to_human`, never to `question.escalated`, so a level hop or a re-notification
// posts nothing. Its test event carries the same kind, so a receiver's routing matches real events.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import type { Question } from '../../src/domain/questions.ts';
import { createGrokBotNotifier } from '../../src/plugins/notifier/grokbot-routine/notifier.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[] }> {
  const hits: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

let seq = 0;
const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-08T16:47:00.000Z', jobId: 'j1', data });

const question = { id: 'q1', jobId: 'j1', text: 'Is this risky?', createdAt: '2026-10-08T16:40:00.000Z', detectedBy: 'protocol', tier: 'human' } as unknown as Question;

function notifier(url: string) {
  const listeners: ((e: DomainEvent) => void)[] = [];
  const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date('2026-10-08T16:48:00.000Z') }, baseMs: 10 });
  n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: (id) => (id === question.id ? question : undefined), waitingOnHuman: () => [], answerUrl: () => 'http://127.0.0.1/q' });
  return { n, send: (e: DomainEvent) => { for (const l of listeners) l(e); } };
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe('Grok Bot routine: question.escalated_to_human only (issue #481)', () => {
  it('posts once when the question reaches the human stage; level hops and re-notifications post nothing', async () => {
    const r = await receiver();
    const { n, send } = notifier(r.url);
    send(event('question.escalated', { questionId: 'q1', target: 'opus', reason: 'asked' }));
    send(event('question.escalated', { questionId: 'q1', target: 'fable', reason: 'opus: unsure' }));
    send(event('question.escalated', { questionId: 'q1', target: 'human', reason: 'fable: the owner\'s call' }));
    await settle();
    expect(r.hits).toHaveLength(0);
    send(event('question.escalated_to_human', { questionId: 'q1', reason: 'fable: the owner\'s call', text: 'Is this risky?', jobId: 'j1', answerUrl: 'http://127.0.0.1/q', notifyCount: 1 }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    send(event('question.escalated', { questionId: 'q1', target: 'human', reason: 'renotify', renotify: true }));
    await settle();
    await n.stop();
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ source: 'hopper', kind: 'question.escalated_to_human', questionId: 'q1', question: 'Is this risky?', jobId: 'j1', offered: false });
  });

  it('Send test event: a marked test payload of kind question.escalated_to_human', async () => {
    const r = await receiver();
    const { n } = notifier(r.url);
    const res = await n.test!();
    await n.stop();
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ source: 'hopper', kind: 'question.escalated_to_human', test: true });
  });
});
