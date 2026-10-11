// The Grok Bot routine without polling (issue #795): it posts each job's end (`job.finished`, `job.failed`), and it
// announces where the hopper is reached from outside (`hopper.reachable`) — at start, when the URL changes, when the
// tunnel comes back, and again on a heartbeat — so Grok Bot always holds a fresh URL. A loopback receiver.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { createGrokBotNotifier } from '../../src/plugins/notifier/grokbot-routine/notifier.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[]; auth: string[] }> {
  const hits: Record<string, unknown>[] = [];
  const auth: string[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { auth.push(req.headers.authorization ?? ''); hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits, auth };
}

const job = { id: 'j1', priority: 50, source: { title: 'Fix the parser', url: 'https://github.com/o/r/issues/7', repo: 'o/r', number: 7, labels: ['hopper'] } } as unknown as Job;
const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id: 'e1', type, at: '2026-10-11T16:00:00.000Z', jobId: 'j1', data });

function notifier(url: string, reach: () => string | undefined = () => undefined, configured = () => true) {
  const listeners: ((e: DomainEvent) => void)[] = [];
  const n = createGrokBotNotifier({
    name: 'grok-bot', routine: () => (configured() ? { url, key: 'k' } : { problem: 'not set' }),
    logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date('2026-10-11T16:01:00.000Z') },
    baseMs: 10, watchMs: 10, heartbeatMs: 300,
  });
  n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: (id) => (id === job.id ? job : undefined), question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '', reach });
  stops.push(() => n.stop());
  return { n, send: (e: DomainEvent) => { for (const l of listeners) l(e); } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Grok Bot routine: a job ends', () => {
  it('posts job.finished with its result and job.failed with its error, with the issue the job came from', async () => {
    const r = await receiver();
    const { send } = notifier(r.url);
    send(event('job.finished', { result: 'pull request ready for review', partlyDone: 'part 2 left' }));
    send(event('job.failed', { error: 'claude exited 1' }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    expect(r.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'hopper', kind: 'job.finished', jobId: 'j1', result: 'pull request ready for review', partlyDone: 'part 2 left', issueTitle: 'Fix the parser', issueUrl: 'https://github.com/o/r/issues/7', repo: 'o/r', issueNumber: 7, priority: 50 }),
      expect.objectContaining({ source: 'hopper', kind: 'job.failed', jobId: 'j1', error: 'claude exited 1', repo: 'o/r', issueNumber: 7 }),
    ]));
  });

  it('posts nothing for a job that is only cancelled or requeued', async () => {
    const r = await receiver();
    const { send } = notifier(r.url);
    send(event('job.cancelled', {}));
    send(event('job.requeued', {}));
    send(event('job.failed', { error: 'boom' }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await sleep(50);
    expect(r.hits.map((h) => h.kind)).toEqual(['job.failed']);
  });
});

describe('Grok Bot routine: where the hopper is reached (hopper.reachable)', () => {
  it('announces the public URL at start, with the bearer key, where an agent gets an API token, and the heartbeat', async () => {
    const r = await receiver();
    notifier(r.url, () => 'https://hopper.example.ngrok.app');
    await waitFor(() => r.hits.length >= 1, { what: 'the announce' });
    expect(r.hits[0]).toEqual({
      source: 'hopper', kind: 'hopper.reachable', at: '2026-10-11T16:01:00.000Z', reason: 'start',
      url: 'https://hopper.example.ngrok.app', apiTokenUrl: 'https://hopper.example.ngrok.app/ui/auth/api-token', heartbeatSeconds: 0.3,
    });
    expect(r.auth[0]).toBe('Bearer k');
  });

  it('announces nothing while the hopper has no public reach', async () => {
    const r = await receiver();
    notifier(r.url, () => undefined);
    await sleep(100);
    expect(r.hits).toEqual([]);
  });

  it('announces again on a heartbeat, so a missed announce heals', async () => {
    const r = await receiver();
    notifier(r.url, () => 'https://a.example');
    await waitFor(() => r.hits.length >= 2, { what: 'a heartbeat', timeoutMs: 3000 });
    expect(r.hits.slice(0, 2).map((h) => h.reason)).toEqual(['start', 'heartbeat']);
  });

  it('announces at once when the URL changes, and when the tunnel comes back after it was down', async () => {
    const r = await receiver();
    let url: string | undefined = 'https://a.example';
    notifier(r.url, () => url);
    await waitFor(() => r.hits.length === 1, { what: 'the start announce' });
    url = 'https://b.example';
    await waitFor(() => r.hits.length === 2, { what: 'the change announce' });
    url = undefined;
    await sleep(50);
    url = 'https://b.example';
    await waitFor(() => r.hits.length === 3, { what: 'the recovery announce' });
    expect(r.hits.slice(0, 3).map((h) => [h.reason, h.url])).toEqual([['start', 'https://a.example'], ['change', 'https://b.example'], ['recovery', 'https://b.example']]);
  });

  it('announces once the routine becomes configured, when the URL was known before', async () => {
    const r = await receiver();
    let configured = false;
    notifier(r.url, () => 'https://a.example', () => configured);
    await sleep(50);
    expect(r.hits).toEqual([]);
    configured = true;
    await waitFor(() => r.hits.some((h) => h.kind === 'hopper.reachable'), { what: 'the announce' });
    expect(r.hits.find((h) => h.kind === 'hopper.reachable')).toMatchObject({ reason: 'start', url: 'https://a.example' });
  });
});
