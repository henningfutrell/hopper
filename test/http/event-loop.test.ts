// Issue #1002: the event loop watchdog. A handler that holds the event loop is a stall: logged with its route, and
// shown as the last stall; a hopper with no stall shows none.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { storeCallsIn, watchEventLoop, type EventLoopStall } from '../../src/http/event-loop.ts';
import { createSlowCalls } from '../../src/store/slow-calls.ts';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function setup(o: { raise?: boolean } = {}) {
  const app = Fastify();
  apps.push(app);
  const lines: string[] = [];
  const raised: (EventLoopStall & { skipped: number })[] = [];
  const slow = createSlowCalls({ slowMs: 50 });
  const watch = watchEventLoop(app, {
    clock: { now: () => new Date('2026-10-13T10:00:00Z') }, warn: (l) => lines.push(l), stallMs: 200, tickMs: 20,
    ...(o.raise ? { storeCalls: slow.since, raise: (s: EventLoopStall & { skipped: number }) => { raised.push(s); }, raiseEveryMs: 60_000 } : {}),
  });
  app.get('/held/:id', async () => {
    const end = Date.now() + 400;
    while (Date.now() < end) { /* holds the event loop */ }
    return { ok: true };
  });
  // A store call that blocks the loop (db.ts), recorded as db.ts records it.
  app.get('/stored', async () => {
    const from = performance.now(), end = Date.now() + 400;
    while (Date.now() < end) { /* a synchronous store call */ }
    slow.record(from, performance.now(), 'SELECT jobs');
    return { ok: true };
  });
  app.get('/quick', async () => ({ ok: true }));
  return { app, lines, watch, raised };
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

  // Issue #1154: what held the loop is named when it was the store, and a stall is raised, not only logged.
  it('names the slow store calls that ran in a stall, by statement', async () => {
    const s = setup({ raise: true });
    await tick(50);
    await s.app.inject({ url: '/stored' });
    await tick(100);
    expect(s.watch.last()?.store).toMatchObject({ calls: [{ what: 'SELECT jobs', count: 1 }] });
    expect(s.watch.last()!.store!.ms).toBeGreaterThanOrEqual(300);
    expect(s.lines[0]).toMatch(/; store calls in it: 0\.\d s \(SELECT jobs 0\.\d s\)$/);
  });

  it('says so when no slow store call ran in a stall', async () => {
    const s = setup({ raise: true });
    await tick(50);
    await s.app.inject({ url: '/held/1' });
    await tick(100);
    expect(s.watch.last()).not.toHaveProperty('store');
    expect(s.lines[0]).toMatch(/; no slow store call in it$/);
  });

  it('raises a stall at most once each interval, and counts the ones between', async () => {
    const s = setup({ raise: true });
    await tick(50);
    await s.app.inject({ url: '/held/1' });
    await tick(100);
    await s.app.inject({ url: '/held/2' });
    await tick(100);
    expect(s.lines).toHaveLength(2);
    expect(s.raised).toHaveLength(1);
    expect(s.raised[0]).toMatchObject({ during: ['GET /held/:id'], skipped: 0 });
  });
});

describe('storeCallsIn', () => {
  it('counts only the part of each call inside the stall, by statement, longest first, at most three', () => {
    const calls = [
      { from: 0, to: 150, what: 'SELECT jobs' },
      { from: 150, to: 400, what: 'SELECT jobs' },
      { from: 400, to: 1000, what: 'INSERT checkpoints' },
      { from: 1000, to: 1010, what: 'UPDATE lanes' },
      { from: 1010, to: 1015, what: 'DELETE events' },
      { from: 2000, to: 2500, what: 'SELECT later' },
    ];
    expect(storeCallsIn(calls, 100, 1100)).toEqual({
      ms: 915,
      calls: [{ what: 'INSERT checkpoints', ms: 600, count: 1 }, { what: 'SELECT jobs', ms: 300, count: 2 }, { what: 'UPDATE lanes', ms: 10, count: 1 }],
    });
    expect(storeCallsIn(calls, 3000, 4000)).toBeUndefined();
  });
});
