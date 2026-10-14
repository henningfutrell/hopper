// Issue #1002: the event loop watchdog. A handler that holds the event loop is a stall: logged with its route, and
// shown as the last stall; a hopper with no stall shows none.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { watchEventLoop } from '../../src/http/event-loop.ts';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function setup() {
  const app = Fastify();
  apps.push(app);
  const lines: string[] = [];
  const watch = watchEventLoop(app, { clock: { now: () => new Date('2026-10-13T10:00:00Z') }, warn: (l) => lines.push(l), stallMs: 200, tickMs: 20 });
  app.get('/held/:id', async () => {
    const end = Date.now() + 400;
    while (Date.now() < end) { /* holds the event loop */ }
    return { ok: true };
  });
  app.get('/quick', async () => ({ ok: true }));
  return { app, lines, watch };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the event loop watchdog (issue #1002)', () => {
  it('no stall: nothing logged, none shown', async () => {
    const s = setup();
    await s.app.inject({ url: '/quick' });
    await tick(100);
    expect(s.watch.last()).toBeUndefined();
    expect(s.lines).toEqual([]);
  });

  it('a handler that holds the event loop is logged and shown with its route, not its URL', async () => {
    const s = setup();
    await tick(50);
    await s.app.inject({ url: '/held/secret-id' });
    await tick(100);
    const stall = s.watch.last();
    expect(stall).toMatchObject({ at: '2026-10-13T10:00:00.000Z', during: ['GET /held/:id'] });
    expect(stall!.ms).toBeGreaterThanOrEqual(200);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(/^hopper: the event loop stalled for \d\.\d s; requests in flight: GET \/held\/:id$/);
    expect(s.lines[0]).not.toContain('secret-id');
  });
});
