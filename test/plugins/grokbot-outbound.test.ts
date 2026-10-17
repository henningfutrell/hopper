// The Grok Bot routine's posts pass the outbound guard (issue #1014): a flood of events reaches the routine as a few
// posts, the same event fed twice is posted once, and each post or held send is in the send log.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import type { OutboundSend } from '../../src/domain/outbound.ts';
import { createOutbound, createOutboundGuard } from '../../src/outbound/index.ts';
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

const finished = (n: number): DomainEvent =>
  ({ seq: n, schemaVersion: 1, id: `e${n}`, type: 'job.finished', jobId: `j${n}`, at: '2026-10-13T10:00:00.000Z', data: { result: {} } });

function setup(url: string, limits: Parameters<typeof createOutboundGuard>[0]['limits']) {
  const clock = { now: () => new Date() };
  const logger = { info: () => undefined, warn: () => undefined };
  const sends: OutboundSend[] = [];
  const outbound = createOutbound({ guard: createOutboundGuard({ clock, logger, limits }), clock, log: { add: (s) => { sends.push(s); }, list: () => sends, prune: () => 0 } });
  const listeners: ((e: DomainEvent) => void)[] = [];
  const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url, key: 'k' }), logger, clock, baseMs: 10, outbound });
  n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
  const feed = (e: DomainEvent) => { for (const l of listeners) l(e); };
  return { n, sends, feed, outbound };
}

describe('Grok Bot routine: the outbound guard (issue #1014)', () => {
  it('a flood of events reaches the routine as a few posts; the rest are held and counted in the send log', async () => {
    const r = await receiver();
    const s = setup(r.url, { burst: 3, perSecond: 1, runawayAsks: 10 });
    for (let i = 1; i <= 2000; i++) s.feed(finished(i));
    const count = (o: string) => s.sends.filter((x) => x.outcome === o).reduce((n, x) => n + x.count, 0);
    // The receiver counts a hit before it answers; the send log has the post only after the answer.
    await waitFor(() => r.hits.length === 3 && count('sent') === 3, { what: 'three posts in the send log' });
    await s.n.stop();
    s.outbound.stop();
    expect(r.hits).toHaveLength(3);
    expect(count('sent')).toBe(3);
    expect(count('sent') + count('rate-limited') + count('circuit-open')).toBe(2000);
    expect(count('circuit-open')).toBeGreaterThan(1900);
    expect(s.sends.length).toBeLessThanOrEqual(10);
    expect(s.sends.every((x) => x.sender === 'notifier' && x.name === 'grok-bot' && !JSON.stringify(x).includes('/routine'))).toBe(true);
  });

  it('the same event fed twice is posted once', async () => {
    const r = await receiver();
    const s = setup(r.url, {});
    s.feed(finished(1));
    s.feed(finished(1));
    await waitFor(() => s.sends.length === 2, { what: 'two log rows' });
    await s.n.stop();
    s.outbound.stop();
    expect(r.hits).toHaveLength(1);
    expect(s.sends.map((x) => x.outcome).sort()).toEqual(['duplicate', 'sent']);
    expect(s.sends.find((x) => x.outcome === 'sent')).toMatchObject({ kind: 'job.finished', jobId: 'j1', status: 200 });
  });
});
