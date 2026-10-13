// The event loop watchdog (issue #1002): the hopper is one process, so code that holds its event loop — a synchronous
// call that waits, a long loop — stops the UI, the API and the engine at once. A timer that runs late by more than
// STALL_MS is a stall: it is logged with the requests that were in flight while it lasted (their routes, never their
// URLs), and `/api/health` shows the last one for STALL_SHOWN_MS. The stack of the code that held the loop cannot be
// read from the loop once it is free again; the routes say which handler it was.
import type { FastifyInstance } from 'fastify';

/** A timer this late is a stall. */
export const STALL_MS = 2000;
/** How long `/api/health` shows the last stall. */
export const STALL_SHOWN_MS = 10 * 60_000;
const TICK_MS = 500;
/** How many ended requests are kept to name the ones a stall overlapped. */
const ENDED_KEPT = 50;

/** A stall of the event loop: when it ended, how long it was, and the requests in flight during it. */
export interface EventLoopStall { at: string; ms: number; during: string[] }

export interface EventLoopWatch {
  /** The last stall, while it is shown. */
  last(): EventLoopStall | undefined;
}

interface Span { route: string; from: number; to?: number }

export function watchEventLoop(app: FastifyInstance, o: { clock: { now(): Date }; warn(line: string): void; stallMs?: number; tickMs?: number }): EventLoopWatch {
  const stallMs = o.stallMs ?? STALL_MS, tickMs = o.tickMs ?? TICK_MS;
  const open = new Map<string, Span>();
  const ended: Span[] = [];
  let last: { stall: EventLoopStall; seen: number } | undefined;

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
    const stall = { at: o.clock.now().toISOString(), ms: Math.round(late), during };
    last = { stall, seen: now };
    o.warn(`hopper: the event loop stalled for ${(late / 1000).toFixed(1)} s; requests in flight: ${during.length ? during.join(', ') : 'none (a timer or the engine held it)'}`);
  }, tickMs);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  return { last: () => (last && performance.now() - last.seen < STALL_SHOWN_MS ? last.stall : undefined) };
}
