// Issue #1002: the event loop watchdog. A handler that holds the event loop is a stall: logged with its route, and
// shown as the last stall; a hopper with no stall shows none.
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { storeCallsBetween, watchEventLoop, type EventLoopStall } from '../../src/http/event-loop.ts';
import { frameOf, HELD_MS, HELD_SAMPLE_MS, watchHeld, type HeldWatch } from '../../src/http/event-loop-held.ts';
import { createSlowCalls } from '../../src/store/slow-calls.ts';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function setup(o: { raise?: boolean; held?: HeldWatch; rss?: () => number; memoryEveryMs?: number } = {}) {
  const app = Fastify();
  apps.push(app);
  const lines: string[] = [];
  const raised: (EventLoopStall & { skipped: number })[] = [];
  const slow = createSlowCalls();
  const watch = watchEventLoop(app, {
    clock: { now: () => new Date('2026-10-13T10:00:00Z') }, warn: (l) => lines.push(l), stallMs: 200, tickMs: 20,
    memory: () => ({ rss: o.rss?.() ?? 300 * 1024 ** 2, heapUsed: 120 * 1024 ** 2, heapTotal: 200 * 1024 ** 2, external: 10 * 1024 ** 2, arrayBuffers: 1024 ** 2 }), ...(o.memoryEveryMs ? { memoryEveryMs: o.memoryEveryMs } : {}),
    ...(o.held ? { held: o.held } : {}),
    ...(o.raise ? { storeCalls: slow.totals, raise: (s: EventLoopStall & { skipped: number }) => { raised.push(s); }, raiseEveryMs: 60_000 } : {}),
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
  // Many store calls, each fast, that hold the loop together (issue #1383).
  app.get('/many', async () => {
    for (let i = 0; i < 40; i++) {
      const from = performance.now(), end = Date.now() + 10;
      while (Date.now() < end) { /* a fast synchronous store call */ }
      slow.record(from, performance.now(), 'SELECT jobs');
    }
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
    expect(s.lines[0]).toMatch(/^hopper: the event loop stalled for \d\.\d s; requests in flight: GET \/held\/:id; memory: 300 MiB resident, 120 MiB heap$/);
    expect(stall!.memory).toEqual({ rssMb: 300, heapMb: 120 });
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
    expect(s.lines[0]).toMatch(/; store calls in it: 0\.\d s \(SELECT jobs 0\.\d s\); memory: /);
  });

  it('says so when no store call ran in a stall', async () => {
    const s = setup({ raise: true });
    await tick(50);
    await s.app.inject({ url: '/held/1' });
    await tick(100);
    expect(s.watch.last()).not.toHaveProperty('store');
    expect(s.lines[0]).toMatch(/; no store call in it; memory: /);
  });

  // Issue #1383: stalls of 57 s to 129 s each said "no slow store call in it", but a stall of many fast calls said the same.
  it('names the store calls of a stall that were each fast, with their count', async () => {
    const s = setup({ raise: true });
    await tick(50);
    await s.app.inject({ url: '/many' });
    await tick(100);
    expect(s.watch.last()?.store).toMatchObject({ calls: [{ what: 'SELECT jobs', count: 40 }] });
    expect(s.watch.last()!.store!.ms).toBeGreaterThanOrEqual(300);
    expect(s.lines[0]).toMatch(/; store calls in it: 0\.\d s \(SELECT jobs 0\.\d s ×40\); memory: /);
  });

  // Issue #1383: an event stream the reader closed never finishes its response, so it stayed "in flight" for good: every
  // stall named it, and each one was kept in memory.
  it('a stream the reader closed is no longer in flight', async () => {
    const s = setup();
    s.app.get('/stream', async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write(': open\n\n');
    });
    const url = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const reader = new AbortController();
    const res = await fetch(`${url}/stream`, { signal: reader.signal });
    expect(res.status).toBe(200);
    reader.abort();
    await tick(100);
    await fetch(`${url}/held/1`);
    await tick(100);
    expect(s.watch.last()?.during).toEqual(['GET /held/:id']);
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

// Issue #1383: what held the loop is read while it is held, by a thread of its own; the time it was held is answered, so
// a dial-in that waited behind it is not stale; the process's memory is said with each stall and logged as it grows.
describe('the event loop read while it is held (issue #1383)', () => {
  const helds: HeldWatch[] = [];
  afterEach(async () => { for (const h of helds.splice(0)) await h.end(); });

  it('a stall names the code the loop ran while it was held', async () => {
    const held = watchHeld({ sampleMs: 300, checkMs: 50, log: false })!;
    helds.push(held);
    const s = setup({ raise: true, held });
    s.app.get('/long', async () => {
      const end = Date.now() + 1200;
      while (Date.now() < end) { /* holds the event loop */ }
      return { ok: true };
    });
    await tick(300); // the worker is up and sees the beat
    await s.app.inject({ url: '/long' });
    await tick(200);
    const stall = s.watch.last()!;
    expect(stall.held?.length).toBeGreaterThan(0);
    expect(stall.held![0]!.afterMs).toBeGreaterThanOrEqual(300);
    expect(stall.held![0]!.frames.join(' ')).toContain('test/http/event-loop.test.ts:');
    expect(s.raised[0]?.held).toEqual(stall.held);
    expect(s.lines[0]).toMatch(/; it ran at \d\.\d s: .*test\/http\/event-loop\.test\.ts:\d+/);
  });

  // Issue #2367: stalls of 2–4 s every minute named no code, as the reads began only at the health port's 5 s.
  it('reads a stall shorter than the health port\'s held line, and the health port still answers 200 then', async () => {
    expect(HELD_SAMPLE_MS).toBeLessThan(HELD_MS);
    expect(HELD_SAMPLE_MS).toBeLessThanOrEqual(2_000);
    const held = watchHeld({ sampleMs: 300, heldMs: 10_000, checkMs: 50, log: false })!;
    helds.push(held);
    const s = setup({ raise: true, held });
    s.app.get('/short', async () => {
      const end = Date.now() + 1200;
      while (Date.now() < end) { /* holds the event loop */ }
      return { ok: true };
    });
    await tick(300);
    await s.app.inject({ url: '/short' });
    await tick(200);
    expect(s.watch.last()!.held!.length).toBeGreaterThan(0);
  });

  it('answers how long the loop was held since a moment, the stall going on included', async () => {
    const s = setup();
    await tick(50);
    const before = Date.now();
    expect(s.watch.heldSince(before)).toBe(0);
    await s.app.inject({ url: '/held/1' });
    await tick(100);
    expect(s.watch.heldSince(before)).toBeGreaterThanOrEqual(200);
    expect(s.watch.heldSince(Date.now())).toBe(0);
    // Read from within a stall, before the watchdog's timer saw it.
    const from = Date.now(), end = from + 400;
    while (Date.now() < end) { /* holds the event loop */ }
    expect(s.watch.heldSince(from)).toBeGreaterThanOrEqual(200);
  });

  it('logs the process\'s resident memory each time it grows past another GiB', async () => {
    let rss = 900 * 1024 ** 2;
    const s = setup({ rss: () => rss, memoryEveryMs: 40 });
    await tick(120);
    expect(s.lines).toEqual([]);
    rss = 2.5 * 1024 ** 3;
    await tick(120);
    rss = 2.7 * 1024 ** 3;
    await tick(120);
    expect(s.lines).toEqual(["hopper: the process's resident memory grew past 2 GiB (2560 MiB)"]);
  });
});

// Issue #1383: the health port answers from the held-loop thread, so a held loop still answers its health, and says so.
describe('the health port (issue #1383)', () => {
  const helds: HeldWatch[] = [];
  afterEach(async () => { for (const h of helds.splice(0)) await h.end(); });

  /**
   * Asks the health port from another process, `afterMs` after it starts. The test waits on it synchronously, so the event
   * loop of this process is held all the while, as a held hopper's is.
   */
  const ask = (port: number, o: { afterMs?: number; host?: string; path?: string } = {}): { status: number; body: string } => {
    // node:http, not fetch: fetch sets the Host header itself.
    const script = `setTimeout(() => require('node:http').get({ host: '127.0.0.1', port: ${port}, path: ${JSON.stringify(o.path ?? '/api/health')}, headers: { host: ${JSON.stringify(o.host ?? `127.0.0.1:${port}`)} } }, (r) => {
      let body = ''; r.on('data', (c) => { body += c; }).on('end', () => { process.stdout.write(JSON.stringify({ status: r.statusCode, body })); });
    }).on('error', (e) => { process.stdout.write(JSON.stringify({ status: 0, body: String(e) })); }), ${o.afterMs ?? 0});`;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 })) as { status: number; body: string };
  };

  // The ask starts a node process while this loop is held: under load that alone can take longer than a short heldMs.
  it('answers the instance\'s health while the loop runs, and says how long it is held while it is', async () => {
    const held = watchHeld({ heldMs: 2_000, checkMs: 50, log: false, health: { port: 0, version: '9.9.9' } })!;
    helds.push(held);
    const port = (await held.healthPort())!;
    expect(port).toBeGreaterThan(0);
    held.beat();
    const fresh = ask(port);
    expect(fresh.status).toBe(200);
    expect(JSON.parse(fresh.body)).toMatchObject({ ok: true, version: '9.9.9' });
    expect(JSON.parse(fresh.body).eventLoopHeldMs).toBeUndefined();
    held.beat();
    const stuck = ask(port, { afterMs: 2_500 });
    expect(stuck.status).toBe(503);
    const body = JSON.parse(stuck.body) as { ok: boolean; version: string; uptimeS: number; eventLoopHeldMs: number };
    expect(body).toMatchObject({ ok: false, version: '9.9.9' });
    expect(body.eventLoopHeldMs).toBeGreaterThanOrEqual(2_000);
  });

  it('answers only its health, and only on a loopback host', async () => {
    const held = watchHeld({ heldMs: 10_000, checkMs: 50, log: false, health: { port: 0, version: '9.9.9' } })!;
    helds.push(held);
    const port = (await held.healthPort())!;
    held.beat();
    expect(ask(port, { host: `localhost:${port}` }).status).toBe(200);
    expect(ask(port, { host: `evil.example:${port}` }).status).toBe(421);
    expect(ask(port, { path: '/api/jobs' }).status).toBe(404);
  });

  it('starts no listener unless a port is given', async () => {
    const held = watchHeld({ heldMs: 300, checkMs: 50, log: false })!;
    helds.push(held);
    expect(await held.healthPort()).toBeUndefined();
  });
});

describe('the process reading (issue #1383)', () => {
  it('says the process\'s memory and the event loop\'s delay', async () => {
    const s = setup();
    await tick(100);
    const r = s.watch.reading();
    expect(r.memory).toEqual({ rssMb: 300, heapUsedMb: 120, heapTotalMb: expect.any(Number), externalMb: expect.any(Number), arrayBuffersMb: expect.any(Number) });
    expect(r.uptimeS).toBeGreaterThanOrEqual(0);
    expect(r.eventLoop.delayMs).toEqual({ mean: expect.any(Number), p50: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) });
    expect(r.eventLoop.utilization).toBeGreaterThanOrEqual(0);
    expect(r.eventLoop.utilization).toBeLessThanOrEqual(1);
    expect(r.eventLoop.windowS).toBeGreaterThanOrEqual(0);
  });

  it('the delay shows a held loop', async () => {
    const s = setup();
    await tick(50);
    await s.app.inject({ url: '/held/1' });
    await tick(50);
    expect(s.watch.reading().eventLoop.delayMs.max).toBeGreaterThanOrEqual(300);
  });
});

describe('frameOf', () => {
  it('names the file in the hopper\'s tree only, never an absolute path', () => {
    expect(frameOf('list', 'file:///home/someone/app/src/store/jobs.ts', 88)).toBe('list (src/store/jobs.ts:88)');
    expect(frameOf('', 'file:///app/node_modules/pg/lib/client.js', 3)).toBe('(anonymous) (node_modules/pg/lib/client.js:3)');
    expect(frameOf('readFileSync', 'node:fs', 441)).toBe('readFileSync (node:fs:441)');
    expect(frameOf('x', '/opt/elsewhere/thing.js', 1)).toBe('x (thing.js:1)');
    expect(frameOf('gc', '', 0)).toBe('gc (native)');
  });
});

describe('storeCallsBetween', () => {
  it('names the store time between two totals, by statement, longest first, at most three', () => {
    const before = new Map([['SELECT jobs', { ms: 100, count: 4 }], ['UPDATE lanes', { ms: 7, count: 1 }]]);
    const after = new Map([
      ['SELECT jobs', { ms: 400.4, count: 10 }], ['UPDATE lanes', { ms: 17, count: 2 }], ['INSERT checkpoints', { ms: 600, count: 1 }],
      ['DELETE events', { ms: 5, count: 1 }],
    ]);
    expect(storeCallsBetween(before, after)).toEqual({
      ms: 915,
      calls: [{ what: 'INSERT checkpoints', ms: 600, count: 1 }, { what: 'SELECT jobs', ms: 300, count: 6 }, { what: 'UPDATE lanes', ms: 10, count: 1 }],
    });
    expect(storeCallsBetween(after, after)).toBeUndefined();
  });
});
