// The event loop watchdog (issue #1002): the hopper is one process, so code that holds its event loop — a synchronous
// call that waits, a long loop — stops the UI, the API and the engine at once. A timer that runs late by more than
// STALL_MS is a stall: it is logged with the requests that were in flight while it lasted (their routes, never their
// URLs), and `/api/health` shows the last one for STALL_SHOWN_MS. The stack of the code that held the loop cannot be
// read from the loop once it is free again; the routes say which handler it was. A store call blocks the loop while it
// lasts (src/store/db.ts): the slow ones that ran during a stall are named with it, by statement (issue #1154). A stall is
// also raised as `hopper.event_loop_stalled`, at most one each RAISE_EVERY_MS, so a person is told, not only the log.
import type { FastifyInstance } from 'fastify';
import type { SlowCall } from '../store/slow-calls.ts';

/** A timer this late is a stall. */
export const STALL_MS = 2000;
/** How long `/api/health` shows the last stall. */
export const STALL_SHOWN_MS = 10 * 60_000;
const TICK_MS = 500;
/** How many ended requests are kept to name the ones a stall overlapped. */
const ENDED_KEPT = 50;
/** A stall is raised as an event at most this often; the stalls between are counted in the next one. */
export const RAISE_EVERY_MS = 60_000;
/** How many statements a stall names. */
const STATEMENTS_NAMED = 3;

/** The store calls that ran during a stall: how long they held the loop in all, and the statements that held it longest. */
export interface StallStoreCalls { ms: number; calls: { what: string; ms: number; count: number }[] }

/**
 * A stall of the event loop: when it ended, how long it was, the requests in flight during it, and the slow store calls
 * that ran in it (absent: none).
 */
export interface EventLoopStall { at: string; ms: number; during: string[]; store?: StallStoreCalls }

/** The store calls of `calls` within [from, to], by statement, longest first. */
export function storeCallsIn(calls: readonly SlowCall[], from: number, to: number): StallStoreCalls | undefined {
  const by = new Map<string, { ms: number; count: number }>();
  for (const c of calls) {
    const ms = Math.min(c.to, to) - Math.max(c.from, from);
    if (ms <= 0) continue;
    const b = by.get(c.what) ?? { ms: 0, count: 0 };
    by.set(c.what, { ms: b.ms + ms, count: b.count + 1 });
  }
  if (!by.size) return undefined;
  const all = [...by].map(([what, b]) => ({ what, ms: Math.round(b.ms), count: b.count })).sort((a, b) => b.ms - a.ms);
  return { ms: all.reduce((n, c) => n + c.ms, 0), calls: all.slice(0, STATEMENTS_NAMED) };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const storeLine = (s: StallStoreCalls | undefined): string => (s
  ? `; store calls in it: ${seconds(s.ms)} (${s.calls.map((c) => `${c.what} ${seconds(c.ms)}${c.count > 1 ? ` ×${c.count}` : ''}`).join(', ')})`
  : '; no slow store call in it');

export interface EventLoopWatch {
  /** The last stall, while it is shown. */
  last(): EventLoopStall | undefined;
}

interface Span { route: string; from: number; to?: number }

export interface WatchOptions {
  clock: { now(): Date };
  warn(line: string): void;
  /** The slow store calls that ended at or after a time (`performance.now()`): src/store/slow-calls.ts. Absent: not named. */
  storeCalls?: (from: number) => readonly SlowCall[];
  /** A stall to tell a person: at most one each `raiseEveryMs`; `skipped`, the stalls since the last one raised. */
  raise?: (stall: EventLoopStall & { skipped: number }) => void;
  stallMs?: number;
  tickMs?: number;
  raiseEveryMs?: number;
}

export function watchEventLoop(app: FastifyInstance, o: WatchOptions): EventLoopWatch {
  const stallMs = o.stallMs ?? STALL_MS, tickMs = o.tickMs ?? TICK_MS, raiseEveryMs = o.raiseEveryMs ?? RAISE_EVERY_MS;
  const open = new Map<string, Span>();
  const ended: Span[] = [];
  let last: { stall: EventLoopStall; seen: number } | undefined;
  let raised: number | undefined;
  let skipped = 0;

  app.addHook('onRequest', async (req) => { open.set(req.id, { route: `${req.method} ${req.routeOptions.url ?? '(no route)'}`, from: performance.now() }); });
  app.addHook('onResponse', async (req) => {
    const s = open.get(req.id);
    if (!s) return;
    open.delete(req.id);
    ended.push({ ...s, to: performance.now() });
    if (ended.length > ENDED_KEPT) ended.shift();
  });

  let at = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), late = now - at - tickMs;
    at = now;
    if (late < stallMs) return;
    const from = now - late;
    const during = [...new Set([...ended.filter((s) => s.to! >= from), ...open.values()].filter((s) => s.from <= now).map((s) => s.route))];
    const store = o.storeCalls ? storeCallsIn(o.storeCalls(from), from, now) : undefined;
    const stall: EventLoopStall = { at: o.clock.now().toISOString(), ms: Math.round(late), during, ...(store ? { store } : {}) };
    last = { stall, seen: now };
    o.warn(`hopper: the event loop stalled for ${seconds(late)}; requests in flight: ${during.length ? during.join(', ') : 'none (a timer or the engine held it)'}${o.storeCalls ? storeLine(store) : ''}`);
    if (!o.raise) return;
    if (raised !== undefined && now - raised < raiseEveryMs) { skipped++; return; }
    raised = now;
    const told = { ...stall, skipped };
    skipped = 0;
    try { o.raise(told); } catch (e) { o.warn(`hopper: the event loop stall could not be raised: ${(e as Error).message}`); }
  }, tickMs);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  return { last: () => (last && performance.now() - last.seen < STALL_SHOWN_MS ? last.stall : undefined) };
}
