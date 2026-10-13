// The send log (issue #1014): each outbound send's row in the user's store, newest first, by name, pruned by age.
import { describe, expect, it } from 'vitest';
import type { OutboundSend } from '../../src/domain/outbound.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const send = (at: string, over: Partial<OutboundSend> = {}): OutboundSend =>
  ({ at, sender: 'webhook', name: 'messaging', host: 'hooks.example', kind: 'job.finished', outcome: 'sent', count: 1, status: 200, ...over });

describe('the send log', () => {
  it('keeps each send, newest first, and lists one name\'s', () => {
    const store = t.open(t.url());
    const a = send('2026-10-13T10:00:00.000Z', { jobId: 'j1' });
    const b = send('2026-10-13T10:00:01.000Z', { sender: 'notifier', name: 'grok-bot', outcome: 'circuit-open', count: 120, status: undefined });
    const c = send('2026-10-13T10:00:02.000Z', { outcome: 'failed', status: 503, error: 'HTTP 503' });
    for (const s of [a, b, c]) store.outboundSends.add(s);
    const { status: _none, ...bStored } = b;
    expect(store.outboundSends.list({ limit: 10 })).toEqual([c, bStored, a]);
    expect(store.outboundSends.list({ limit: 1 })).toEqual([c]);
    expect(store.outboundSends.list({ limit: 10, name: 'grok-bot' })).toEqual([bStored]);
    store.close();
  });

  it('prunes the rows from before a time', () => {
    const store = t.open(t.url());
    store.outboundSends.add(send('2026-09-01T00:00:00.000Z'));
    store.outboundSends.add(send('2026-10-13T00:00:00.000Z'));
    expect(store.outboundSends.prune('2026-10-01T00:00:00.000Z')).toBe(1);
    expect(store.outboundSends.list({ limit: 10 }).map((s) => s.at)).toEqual(['2026-10-13T00:00:00.000Z']);
    store.close();
  });
});
