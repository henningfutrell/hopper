// Issue #698: a login a job waits on reaches the person's phone as well as the UI. The Grok Bot routine posts
// `auth.pending` (a new code too) and `auth.expired`, with what asks (the tool and its host), what waits (job, issue,
// machine, lane), when the code runs out, and a link to the Logins view — never the URL to open or the code: those
// stay in the hopper's memory, for a UI session of the user (design.md "Logins", "Sensitive data").
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

const AT = '2026-10-10T12:00:00.000Z';
const JOB = {
  id: 'j1', priority: 75, source: { title: 'Fix the deploy', url: 'https://github.com/o/r/issues/7', repo: 'o/r', number: 7, labels: ['hopper'] },
} as unknown as Job;
const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id: 'e1', type, at: AT, jobId: 'j1', laneId: 'm1/lane-2', machineId: 'm1', data });

describe('Grok Bot routine: logins (issue #698)', () => {
  it('posts a pending login and an expired one, with what asks and what waits, and never the code or its URL', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date(AT) }, baseMs: 10 });
    n.start({
      subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => JOB, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '',
      highPriority: () => 70, loginsUrl: () => 'http://hopper.lan:4790/#logins',
    });
    const send = (e: DomainEvent) => { for (const l of listeners) l(e); };
    send(event('auth.pending', { loginId: 'l1', kind: 'device_code', tool: 'aws sso login', host: 'device.sso.eu-west-1.amazonaws.com', expiresAt: '2026-10-10T12:10:00.000Z', run: 'herdr-claude', priority: 75, high: true }));
    send(event('auth.expired', { loginId: 'l1', kind: 'device_code', tool: 'aws sso login', expiresAt: AT }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    const pending = r.hits.find((h) => h.kind === 'auth.pending')!;
    expect(pending).toMatchObject({
      source: 'hopper', at: AT, jobId: 'j1', issueTitle: 'Fix the deploy', issueUrl: 'https://github.com/o/r/issues/7', repo: 'o/r', issueNumber: 7,
      loginId: 'l1', tool: 'aws sso login', host: 'device.sso.eu-west-1.amazonaws.com', run: 'herdr-claude',
      machineId: 'm1', laneId: 'm1/lane-2', priority: 75, high: true, expiresAt: '2026-10-10T12:10:00.000Z', expiresInSeconds: 600,
      loginsUrl: 'http://hopper.lan:4790/#logins',
    });
    expect(pending).not.toHaveProperty('userCode');
    expect(pending).not.toHaveProperty('verificationUrl');
    expect(r.hits.find((h) => h.kind === 'auth.expired')).toMatchObject({ loginId: 'l1', tool: 'aws sso login', expiresInSeconds: 0, loginsUrl: 'http://hopper.lan:4790/#logins' });
  });

  it('posts nothing for a login that completed, was cancelled or failed', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date(AT) }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => JOB, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    for (const type of ['auth.completed', 'auth.cancelled', 'auth.failed'] as const) for (const l of listeners) l(event(type, { loginId: 'l1', kind: 'device_code', tool: 'x' }));
    for (const l of listeners) l(event('source.stalled', { source: 's', kind: 'github-account', error: 'e', since: AT }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits.map((h) => h.kind)).toEqual(['source.stalled']);
  });
});
