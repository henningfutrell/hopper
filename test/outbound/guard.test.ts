// The outbound guard and the send log (issue #1014): a destination's rate limit, the dedupe of a send asked again, the
// circuit a runaway opens, and the rows each send leaves in the send log.
import { describe, expect, it } from 'vitest';
import { askDestination, freshDestination, hostOf, OUTBOUND_LIMITS, takeToken, type OutboundLimits, type OutboundSend } from '../../src/domain/outbound.ts';
import { createOutbound, createOutboundGuard, type OutboundRequest } from '../../src/outbound/index.ts';

const limits: OutboundLimits = { burst: 3, perSecond: 1, dedupeMs: 60_000, runawayAsks: 5, runawayWindowMs: 10_000, openMs: 30_000 };

function clockAt(ms = Date.parse('2026-10-13T10:00:00.000Z')) {
  let t = ms;
  return { now: () => new Date(t), advance: (d: number) => { t += d; } };
}

const quiet = () => {
  const warned: string[] = [];
  return { warned, logger: { info: () => undefined, warn: (l: string) => { warned.push(l); } } };
};

function memoryLog() {
  const rows: OutboundSend[] = [];
  return {
    rows,
    add: (s: OutboundSend) => { rows.push(s); },
    list: ({ limit }: { limit: number }) => [...rows].reverse().slice(0, limit),
    prune: () => 0,
  };
}

const req = (over: Partial<OutboundRequest> = {}): OutboundRequest =>
  ({ sender: 'notifier', name: 'grok-bot', url: 'https://routine.example/hook/SECRET-PATH?key=x', kind: 'job.finished', ...over });

describe('the guard\'s arithmetic', () => {
  it('takes tokens up to the burst, then says how long until the next', () => {
    let s = freshDestination(0, limits);
    for (let i = 0; i < 3; i++) { const r = takeToken(s, 0, limits); expect(r.waitMs).toBe(0); s = r.state; }
    const empty = takeToken(s, 0, limits);
    expect(empty.waitMs).toBe(1000);
    expect(takeToken(empty.state, 1000, limits).waitMs).toBe(0);
  });

  it('opens the circuit on the ask past the runaway limit, and keeps it open for openMs', () => {
    let s = freshDestination(0, limits);
    for (let i = 0; i < 5; i++) { const a = askDestination(s, i, limits); expect(a.open).toBe(false); s = a.state; }
    const sixth = askDestination(s, 5, limits);
    expect(sixth).toMatchObject({ open: true, opened: true });
    expect(askDestination(sixth.state, 29_000, limits)).toMatchObject({ open: true, opened: false });
    expect(askDestination(sixth.state, 30_005, limits)).toMatchObject({ open: false });
  });

  it('counts the asks per window: a slow, steady sender never opens it', () => {
    let s = freshDestination(0, limits);
    for (let i = 0; i < 50; i++) { const a = askDestination(s, i * 2500, limits); expect(a.open).toBe(false); s = a.state; }
  });

  it('names a destination by its host only', () => {
    expect(hostOf('https://routine.example:8443/hook/SECRET?key=x')).toBe('routine.example:8443');
    expect(hostOf('not a url')).toBe('invalid URL');
  });

  it('defaults stop a flood of thousands a second within one second', () => {
    let s = freshDestination(0, OUTBOUND_LIMITS);
    let posted = 0;
    let open = false;
    for (let i = 0; i < 10_000 && !open; i++) {
      const a = askDestination(s, i / 10, OUTBOUND_LIMITS);
      s = a.state;
      open = a.open;
      if (!open) { const t = takeToken(s, i / 10, OUTBOUND_LIMITS); s = t.state; if (t.waitMs === 0) posted++; }
    }
    expect(open).toBe(true);
    expect(posted).toBeLessThanOrEqual(OUTBOUND_LIMITS.burst + 1);
  });
});

describe('the outbound guard', () => {
  it('a send with a key asked again within the dedupe window is a duplicate; after it, a send again', () => {
    const clock = clockAt();
    const guard = createOutboundGuard({ clock, logger: quiet().logger, limits });
    expect(guard.ask(req({ key: 'e1' }))).toBe('ok');
    expect(guard.ask(req({ key: 'e1' }))).toBe('duplicate');
    expect(guard.ask(req({ key: 'e1', url: 'https://other.example/hook' }))).toBe('ok');
    expect(guard.ask(req({ key: 'e2' }))).toBe('ok');
    clock.advance(60_001);
    expect(guard.ask(req({ key: 'e1' }))).toBe('ok');
  });

  it('a runaway opens the circuit once, with one line naming the host and the last sender, never the path', () => {
    const clock = clockAt();
    const q = quiet();
    const guard = createOutboundGuard({ clock, logger: q.logger, limits });
    const answers = Array.from({ length: 20 }, () => guard.ask(req()));
    expect(answers.filter((a) => a === 'ok')).toHaveLength(5);
    expect(answers.slice(5).every((a) => a === 'circuit-open')).toBe(true);
    expect(guard.isOpen(req().url)).toBe(true);
    expect(q.warned).toHaveLength(1);
    expect(q.warned[0]).toContain('routine.example');
    expect(q.warned[0]).toContain('notifier grok-bot job.finished');
    expect(q.warned[0]).not.toContain('SECRET');
    expect(guard.circuits([req().url])).toEqual([{ host: 'routine.example', until: '2026-10-13T10:00:30.000Z' }]);
    clock.advance(30_000);
    expect(guard.isOpen(req().url)).toBe(false);
    expect(guard.ask(req())).toBe('ok');
  });

  it('one destination\'s runaway leaves another\'s sends alone', () => {
    const guard = createOutboundGuard({ clock: clockAt(), logger: quiet().logger, limits });
    for (let i = 0; i < 10; i++) guard.ask(req());
    expect(guard.ask(req({ url: 'https://other.example/hook' }))).toBe('ok');
  });
});

describe('the send log', () => {
  it('a POST leaves one row: sent with its status, or failed with why', async () => {
    const clock = clockAt();
    const log = memoryLog();
    const out = createOutbound({ guard: createOutboundGuard({ clock, logger: quiet().logger, limits }), clock, log });
    expect(await out.send(req({ jobId: 'j1' }), async () => ({ status: 200 }))).toEqual({ status: 200 });
    await out.send(req({ kind: 'question.escalated_to_human' }), async () => ({ status: 503, error: 'HTTP 503' }));
    out.stop();
    expect(log.rows).toEqual([
      { at: '2026-10-13T10:00:00.000Z', sender: 'notifier', name: 'grok-bot', host: 'routine.example', kind: 'job.finished', outcome: 'sent', count: 1, status: 200, jobId: 'j1' },
      { at: '2026-10-13T10:00:00.000Z', sender: 'notifier', name: 'grok-bot', host: 'routine.example', kind: 'question.escalated_to_human', outcome: 'failed', count: 1, status: 503, error: 'HTTP 503' },
    ]);
  });

  it('held sends are never posted; a flood leaves a few rows, its repeats counted', async () => {
    const clock = clockAt();
    const log = memoryLog();
    const out = createOutbound({ guard: createOutboundGuard({ clock, logger: quiet().logger, limits }), clock, log });
    let posts = 0;
    for (let i = 0; i < 1000; i++) await out.send(req(), async () => { posts++; return { status: 200 }; });
    out.stop();
    expect(posts).toBe(3);
    const by = (outcome: string) => log.rows.filter((r) => r.outcome === outcome).reduce((n, r) => n + r.count, 0);
    expect(by('sent')).toBe(3);
    expect(by('rate-limited')).toBe(2);
    expect(by('circuit-open')).toBe(995);
    expect(log.rows.length).toBeLessThanOrEqual(7);
    expect(out.circuits()).toEqual([{ host: 'routine.example', until: '2026-10-13T10:00:30.000Z' }]);
  });

  it('a duplicate is logged and not posted', async () => {
    const clock = clockAt();
    const log = memoryLog();
    const out = createOutbound({ guard: createOutboundGuard({ clock, logger: quiet().logger, limits }), clock, log });
    let posts = 0;
    const post = async () => { posts++; return { status: 200 }; };
    await out.send(req({ key: 'e1' }), post);
    expect(await out.send(req({ key: 'e1' }), post)).toMatchObject({ held: 'duplicate' });
    out.stop();
    expect(posts).toBe(1);
    expect(log.rows.map((r) => r.outcome)).toEqual(['sent', 'duplicate']);
  });
});
