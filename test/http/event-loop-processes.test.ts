// Issue #2367: stalls of 2–4 s each minute held almost no store time. Each process the hopper starts holds the event loop
// while it forks, and the update check started about 2,400 git processes a minute. A stall now names the processes
// started in it, by program, as it names the store calls.
import { execFile } from 'node:child_process';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { watchEventLoop, type EventLoopStall } from '../../src/http/event-loop.ts';
import { processesBetween, watchProcesses } from '../../src/http/event-loop-processes.ts';

const apps: ReturnType<typeof Fastify>[] = [];
const watches: ReturnType<typeof watchProcesses>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const w of watches.splice(0)) w.end();
});

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const app = Fastify();
  apps.push(app);
  const processes = watchProcesses();
  watches.push(processes);
  const lines: string[] = [];
  const raised: (EventLoopStall & { skipped: number })[] = [];
  const watch = watchEventLoop(app, {
    clock: { now: () => new Date('2026-10-21T10:00:00Z') }, warn: (l) => lines.push(l), stallMs: 200, tickMs: 20,
    memory: () => ({ rss: 300 * 1024 ** 2, heapUsed: 120 * 1024 ** 2 }), processes: processes.totals,
    raise: (s) => { raised.push(s); },
  });
  // A handler that starts processes and holds the loop.
  app.get('/spawns', async () => {
    for (let i = 0; i < 5; i++) execFile('true', () => undefined);
    execFile(process.execPath, ['-e', ''], () => undefined);
    const end = Date.now() + 400;
    while (Date.now() < end) { /* holds the event loop */ }
    return { ok: true };
  });
  app.get('/held', async () => {
    const end = Date.now() + 400;
    while (Date.now() < end) { /* holds the event loop */ }
    return { ok: true };
  });
  return { app, lines, watch, raised };
}

describe('the processes a stall started (issue #2367)', () => {
  it('names the processes started in a stall, by program, most first', async () => {
    const s = setup();
    await tick(50);
    await s.app.inject({ url: '/spawns' });
    await tick(100);
    const stall = s.watch.last();
    expect(stall?.processes).toEqual({ count: 6, programs: [{ what: 'true', count: 5 }, { what: 'node', count: 1 }] });
    expect(s.lines[0]).toMatch(/; processes started in it: 6 \(true ×5, node\); memory: /);
    expect(s.raised[0]?.processes).toEqual(stall?.processes);
  });

  it('says nothing of processes when a stall started none', async () => {
    const s = setup();
    await tick(50);
    await s.app.inject({ url: '/held' });
    await tick(100);
    expect(s.watch.last()).not.toHaveProperty('processes');
    expect(s.lines[0]).not.toContain('processes');
  });
});

describe('processesBetween', () => {
  it('counts each program between two totals, most first, at most three named', () => {
    const before = new Map([['git', 10], ['herdr', 2]]);
    const after = new Map([['git', 50], ['herdr', 5], ['ssh', 1], ['podman', 2], ['node', 1]]);
    expect(processesBetween(before, after)).toEqual({
      count: 47, programs: [{ what: 'git', count: 40 }, { what: 'herdr', count: 3 }, { what: 'podman', count: 2 }],
    });
    expect(processesBetween(after, after)).toBeUndefined();
  });

  it('names a program by its file name only, never its path', async () => {
    const processes = watchProcesses();
    watches.push(processes);
    await new Promise((resolve) => { execFile('/bin/true', resolve); });
    expect([...processes.totals().keys()]).toEqual(['true']);
  });
});
