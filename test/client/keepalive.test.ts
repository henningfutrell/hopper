// The link's keepalive (issue #752) and its missed heartbeat (issue #1569): a PING not answered within one interval is a
// missed heartbeat, said once, before the link is dropped at the PING timeout. The session is a stand-in: only `ping`,
// `destroyed` and `close` are read.
import { EventEmitter } from 'node:events';
import type { Http2Session } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';
import { keepAlive } from '../../src/client/keepalive.ts';
import { waitFor } from '../support/wait.ts';

const sessions: EventEmitter[] = [];
afterEach(() => { for (const s of sessions.splice(0)) s.emit('close'); });

/** A session whose PINGs wait for `answer()`, or are answered at once while `auto` is set. */
function session(auto = false): Http2Session & { answer(): void } {
  const waiting: ((err: Error | null) => void)[] = [];
  const s = Object.assign(new EventEmitter(), {
    destroyed: false,
    ping(cb: (err: Error | null) => void): boolean { if (auto) setImmediate(() => cb(null)); else waiting.push(cb); return true; },
    answer() { for (const cb of waiting.splice(0)) cb(null); },
  });
  sessions.push(s);
  return s as unknown as Http2Session & { answer(): void };
}

describe('the missed heartbeat', () => {
  it('is said once when a PING is not answered within one interval, before the link is dropped', async () => {
    const said: string[] = [];
    keepAlive(session(), () => said.push('drop'), { everyMs: 20, timeoutMs: 200 }, undefined, () => said.push('late'));
    await waitFor(() => said.includes('drop'), { timeoutMs: 2000, what: 'the link dropped' });
    expect(said).toEqual(['late', 'drop']);
  });

  it('is never said on a link whose PINGs are answered', async () => {
    const said: string[] = [];
    keepAlive(session(true), () => said.push('drop'), { everyMs: 10, timeoutMs: 100 }, undefined, () => said.push('late'));
    await new Promise((r) => setTimeout(r, 200));
    expect(said).toEqual([]);
  });

  it('is said again for a later PING once the late one was answered', async () => {
    const s = session();
    const said: string[] = [];
    keepAlive(s, () => said.push('drop'), { everyMs: 20, timeoutMs: 10_000 }, () => said.push('answered'), () => said.push('late'));
    await waitFor(() => said.includes('late'), { timeoutMs: 2000, what: 'the first missed heartbeat' });
    await new Promise((r) => setTimeout(r, 60));
    expect(said).toEqual(['late']);
    s.answer();
    await waitFor(() => said.filter((x) => x === 'late').length === 2, { timeoutMs: 2000, what: 'the next missed heartbeat' });
    expect(said).toEqual(['late', 'answered', 'late']);
  });
});
