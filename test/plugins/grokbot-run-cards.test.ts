// Issue #2197 part 2: each new run card reaches the person's phone as well as the Access requests badge. The Grok Bot
// routine posts `vault.run_card_opened` with the job, why it asks, what the one approval approves, the job's priority and
// whether it is high, and a link to Access requests.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
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

const AT = '2026-10-19T12:00:00.000Z';
const job = (id: string, priority: number) =>
  ({ id, priority, source: { title: `Fix ${id}`, url: `https://github.com/o/r/issues/${priority}`, repo: 'o/r', number: priority, labels: ['hopper'] } }) as unknown as Job;
const JOBS: Record<string, Job> = { j1: job('j1', 100), j2: job('j2', 50) };
const card = (id: string, jobId: string, data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id, type: 'vault.run_card_opened', at: AT, jobId, data });

describe('Grok Bot routine: run cards (issue #2197)', () => {
  it('posts each new run card with the job, why it asks, what waits, its priority and the Access requests link', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date(AT) }, baseMs: 10 });
    n.start({
      subscribe: (l) => { listeners.push(l); return () => undefined; }, job: (id) => JOBS[id], question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '',
      highPriority: () => 75, accessUrl: () => 'http://hopper.lan:4790/#access-requests',
    });
    const send = (e: DomainEvent) => { for (const l of listeners) l(e); };
    send(card('e1', 'j1', { template: 'asked-1', waits: { template: true, run: true }, purpose: 'Rotate the deploy key' }));
    send(card('e2', 'j2', { template: 'asked-2', waits: { template: true, run: false } }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits.find((h) => h.jobId === 'j1')).toEqual({
      source: 'hopper', kind: 'vault.run_card_opened', at: AT, jobId: 'j1', issueTitle: 'Fix j1', issueUrl: 'https://github.com/o/r/issues/100',
      repo: 'o/r', issueNumber: 100, priority: 100, high: true, template: 'asked-1', waits: { template: true, run: true }, purpose: 'Rotate the deploy key',
      accessUrl: 'http://hopper.lan:4790/#access-requests',
    });
    expect(r.hits.find((h) => h.jobId === 'j2')).toMatchObject({ priority: 50, high: false, template: 'asked-2', waits: { template: true, run: false } });
    expect(r.hits.find((h) => h.jobId === 'j2')).not.toHaveProperty('purpose');
  });
});
