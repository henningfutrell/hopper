// Issue #2716: a step schedule's run that fails reaches the person's phone as a failed job does. The Grok Bot routine
// posts `step_schedule.run_failed` with the schedule, the run, its exit code and why; a run that succeeded is not posted.
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

const AT = '2026-10-25T02:03:00.000Z';
const event = (id: string, type: 'step_schedule.run_failed' | 'step_schedule.run_finished', data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id, type, at: AT, data });

describe('Grok Bot routine: a failed scheduled run (issue #2716)', () => {
  it('posts the run that failed, with its schedule, exit code and why; a run that succeeded is not posted', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date(AT) }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const send = (e: DomainEvent) => { for (const l of listeners) l(e); };
    send(event('e0', 'step_schedule.run_finished', { schedule: 'nightly-backup', run: 'r0', exit: 0, seconds: 40 }));
    send(event('e1', 'step_schedule.run_failed', { schedule: 'nightly-backup', run: 'r1', exit: 1, seconds: 37, outcome: 'failed' }));
    send(event('e2', 'step_schedule.run_failed', { schedule: 'nightly-backup', run: 'r2', exit: 125, seconds: 0, outcome: 'failed', problem: 'schedule nightly-backup has no vault grant' }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits.find((h) => h.run === 'r1')).toMatchObject({ source: 'hopper', kind: 'step_schedule.run_failed', at: AT, schedule: 'nightly-backup', exit: 1, outcome: 'failed', error: 'the script exited 1' });
    expect(r.hits.find((h) => h.run === 'r2')).toMatchObject({ exit: 125, error: 'schedule nightly-backup has no vault grant' });
    expect(r.hits.some((h) => h.run === 'r0')).toBe(false);
  });
});
