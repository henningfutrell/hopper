// The Grok Bot routine tells the owner when intake stops (issue #358): besides a question that reaches
// the human, it posts `source.stalled` (a source in error past the stall threshold) and
// `connected_account.expired` (a connected account whose sign-in ended). A loopback receiver.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
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

const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id: 'e1', type, at: '2026-10-07T20:44:00.000Z', data });

describe('Grok Bot routine: intake stopped', () => {
  it('posts source.stalled and connected_account.expired', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const send = (e: DomainEvent) => { for (const l of listeners) l(e); };
    send(event('source.stalled', { source: 'github-account', kind: 'github-account', error: 'GitHub refused the token', since: '2026-10-07T20:14:00.000Z' }));
    send(event('connected_account.expired', { provider: 'github', account: 'octo-user', reason: 'GitHub refused the refresh token' }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'hopper', kind: 'source.stalled', sourceName: 'github-account', error: 'GitHub refused the token', since: '2026-10-07T20:14:00.000Z' }),
      expect.objectContaining({ source: 'hopper', kind: 'connected_account.expired', provider: 'github', account: 'octo-user', reason: 'GitHub refused the refresh token' }),
    ]));
  });
});
