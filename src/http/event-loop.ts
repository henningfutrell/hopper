// The event loop watchdog (issue #1002): the hopper is one process, so code that holds its event loop — a synchronous
// call that waits, a long loop — stops the UI, the API and the engine at once. A timer that runs late by more than
// STALL_MS is a stall: it is logged with the requests that were in flight while it lasted (their routes, never their
// URLs), and `/api/health` shows the last one for STALL_SHOWN_MS. The stack of the code that held the loop cannot be
// read from the loop once it is free again; the routes say which handler it was. A store call blocks the loop while it
// lasts (src/store/db.ts): the store calls that ran during a stall are named with it, by statement (issue #1154) — all of
// them, from the store's totals read at each tick, so many fast calls are named as well as one slow one (issue #1383). A stall is
// also raised as `hopper.event_loop_stalled`, at most one each RAISE_EVERY_MS, so a person is told, not only the log.
// Issue #1383: a worker thread reads where the loop runs while it is held (event-loop-held.ts), so a stall with no store
// call in it names its code too (`held`); a stall says the process's memory (`memory`); and the time the loop was held
// since a moment is answered (`heldSince`), so a dial-in that waited behind a stall is not refused as stale. The process's
// memory is logged each time its resident size grows past another GiB. The process reading (`reading`, GET /api/process,
// issue #1383) says the memory now, and the loop's delay and use over the last minute, so growth and a slow loop show
// before they become a stall. Issue #2367: the processes the hopper started in a stall are named with it, by program
// (event-loop-processes.ts), as each one holds the loop while it forks.
import { monitorEventLoopDelay, performance as perf, type EventLoopUtilization } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { HeldSample, HeldWatch } from './event-loop-held.ts';
import type { StoreTotal } from '../store/slow-calls.ts';
import { processesBetween, type StallProcesses } from './event-loop-processes.ts';

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
/** How often the process's memory is read for growth. */
const MEMORY_EVERY_MS = 60_000;
const GIB = 1024 ** 3;
/** How long a stall counts in `heldSince`. */
const STALLS_KEPT_MS = 10 * 60_000;

/** The store calls that ran during a stall: how long they held the loop in all, and the statements that held it longest. */
export interface StallStoreCalls { ms: number; calls: { what: string; ms: number; count: number }[] }

/** Where the held loop ran (issue #1383): each read, `afterMs` into the stall, its frames from the top. */
export interface StallHeld { afterMs: number; frames: string[] }

/** The process's memory when a stall ended, in MiB: its resident size and the JavaScript heap in use. */
export interface StallMemory { rssMb: number; heapMb: number }

/**
 * A stall of the event loop: when it ended, how long it was, the requests in flight during it, the store calls
 * that ran in it (absent: none), the processes started in it (absent: none), where the loop ran while it was held
 * (absent: not read), and the memory.
 */
export interface EventLoopStall { at: string; ms: number; during: string[]; store?: StallStoreCalls; processes?: StallProcesses; held?: StallHeld[]; memory?: StallMemory }

/** The store calls between two totals (src/store/slow-calls.ts), by statement, longest first. */
export function storeCallsBetween(before: ReadonlyMap<string, StoreTotal>, after: ReadonlyMap<string, StoreTotal>): StallStoreCalls | undefined {
  const all = [...after].map(([what, t]) => ({ what, ms: Math.round(t.ms - (before.get(what)?.ms ?? 0)), count: t.count - (before.get(what)?.count ?? 0) }))
    .filter((c) => c.count > 0).sort((a, b) => b.ms - a.ms);
  if (!all.length) return undefined;
  return { ms: all.reduce((n, c) => n + c.ms, 0), calls: all.slice(0, STATEMENTS_NAMED) };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const storeLine = (s: StallStoreCalls | undefined): string => (s
  ? `; store calls in it: ${seconds(s.ms)} (${s.calls.map((c) => `${c.what} ${seconds(c.ms)}${c.count > 1 ? ` ×${c.count}` : ''}`).join(', ')})`
  : '; no store call in it');

const processLine = (p: StallProcesses | undefined): string => (p
  ? `; processes started in it: ${p.count} (${p.programs.map((x) => `${x.what}${x.count > 1 ? ` ×${x.count}` : ''}`).join(', ')})`
  : '');

const heldLine = (h: StallHeld[] | undefined): string => (h?.length
  ? `; it ran ${h.map((r) => `at ${seconds(r.afterMs)}: ${r.frames.slice(0, 3).join(' ← ') || 'no JavaScript'}`).join('; ')}`
  : '');

const mib = (bytes: number): number => Math.round(bytes / 1024 ** 2);

/**
 * The process now (issue #1383): its memory in MiB, and its event loop over the last minute (`windowS`, shorter before a
 * first minute): the delay of its timers in ms, and its use, the share of the time it ran code (0..1).
 */
export interface ProcessReading {
  uptimeS: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number };
  eventLoop: { windowS: number; delayMs: { mean: number; p50: number; p99: number; max: number }; utilization: number };
}

type Memory = { rss: number; heapUsed: number; heapTotal?: number; external?: number; arrayBuffers?: number };

export interface EventLoopWatch {
  /** The last stall, while it is shown. */
  last(): EventLoopStall | undefined;
  /** The process now: its memory, and its event loop over the last minute. */
  reading(): ProcessReading;
  /**
   * How long the loop was held since `from` (ms since the epoch): the stalls since, and the one still going on. A request
   * signed at `from` and read only now waited that long behind the loop, not on the wire.
   */
  heldSince(from: number): number;
}

interface Span { route: string; from: number; to?: number }

export interface WatchOptions {
  clock: { now(): Date };
  warn(line: string): void;
  /** The store's totals by statement now (src/store/slow-calls.ts). Absent: the store calls are not named. */
  storeCalls?: () => ReadonlyMap<string, StoreTotal>;
  /** The processes started so far, by program (event-loop-processes.ts). Absent: the processes are not named. */
  processes?: () => ReadonlyMap<string, number>;
  /** A stall to tell a person: at most one each `raiseEveryMs`; `skipped`, the stalls since the last one raised. */
  raise?: (stall: EventLoopStall & { skipped: number }) => void;
  /** The thread that reads where the loop is held (event-loop-held.ts). Absent: a stall does not say. */
  held?: HeldWatch;
  /** The process's memory; default `process.memoryUsage()`. */
  memory?: () => Memory;
  stallMs?: number;
  tickMs?: number;
  raiseEveryMs?: number;
  memoryEveryMs?: number;
}

export function watchEventLoop(app: FastifyInstance, o: WatchOptions): EventLoopWatch {
  const stallMs = o.stallMs ?? STALL_MS, tickMs = o.tickMs ?? TICK_MS, raiseEveryMs = o.raiseEveryMs ?? RAISE_EVERY_MS, memoryEveryMs = o.memoryEveryMs ?? MEMORY_EVERY_MS;
  const open = new Map<string, Span>();
  const ended: Span[] = [];
  let last: { stall: EventLoopStall; seen: number } | undefined;
  let raised: number | undefined;
  let skipped = 0;
  const memory = o.memory ?? (() => process.memoryUsage());
  /** The stalls of the last STALLS_KEPT_MS, in ms since the epoch. */
  const stalls: { from: number; to: number }[] = [];
  let beat = o.held?.beat() ?? Date.now();
  let rssStep = 0, memoryAt = performance.now();
  // The loop's delay and use, over the minute that ended last and the one going on.
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let window: { from: number; elu: EventLoopUtilization; read?: { windowS: number; delayMs: ProcessReading['eventLoop']['delayMs']; utilization: number } } = { from: performance.now(), elu: perf.eventLoopUtilization() };
  const loopNow = (): { windowS: number; delayMs: ProcessReading['eventLoop']['delayMs']; utilization: number } => {
    const ms = (ns: number): number => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : 0);
    return {
      windowS: Math.round((performance.now() - window.from) / 1000),
      delayMs: { mean: ms(delay.mean), p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
      utilization: Math.round(perf.eventLoopUtilization(window.elu).utilization * 1000) / 1000,
    };
  };
  /** The store's totals at the last tick: a stall's store calls are the difference at its end. */
  let storeAt = o.storeCalls?.(), processesAt = o.processes?.();

  const end = (id: string): void => {
    const s = open.get(id);
    if (!s) return;
    open.delete(id);
    ended.push({ ...s, to: performance.now() });
    if (ended.length > ENDED_KEPT) ended.shift();
  };
  app.addHook('onRequest', async (req, reply) => {
    open.set(req.id, { route: `${req.method} ${req.routeOptions.url ?? '(no route)'}`, from: performance.now() });
    // A response that never finishes — an event stream its reader closed, a request the client dropped — gets no
    // onResponse: it ends when its socket closes (issue #1383), or it stays in flight in every stall, and in memory.
    reply.raw.once('close', () => { end(req.id); });
  });
  app.addHook('onResponse', async (req) => { end(req.id); });

  let at = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), late = now - at - tickMs, since = beat, wall = Date.now();
    at = now;
    beat = o.held?.beat() ?? wall;
    const storeBefore = storeAt, processesBefore = processesAt;
    storeAt = o.storeCalls?.();
    processesAt = o.processes?.();
    if (now - memoryAt >= memoryEveryMs) {
      memoryAt = now;
      watchMemory();
      window = { from: now, elu: perf.eventLoopUtilization(), read: loopNow() };
      delay.reset();
    }
    if (late < stallMs) return;
    stalls.push({ from: wall - late, to: wall });
    while (stalls.length && stalls[0]!.to < wall - STALLS_KEPT_MS) stalls.shift();
    // The held thread's last read is a message still in the queue: read it after the queue's turn.
    const processes = processesBefore && processesAt ? processesBetween(processesBefore, processesAt) : undefined;
    setImmediate(() => { stalled(now, late, o.held?.of(since) ?? [], storeBefore && storeAt ? storeCallsBetween(storeBefore, storeAt) : undefined, processes); });
  }, tickMs);
  const watchMemory = (): void => {
    const rss = memory().rss, step = Math.floor(rss / GIB);
    if (step <= rssStep) return;
    rssStep = step;
    o.warn(`hopper: the process's resident memory grew past ${step} GiB (${mib(rss)} MiB)`);
  };
  const stalled = (now: number, late: number, reads: HeldSample[], store: StallStoreCalls | undefined, processes: StallProcesses | undefined): void => {
    const from = now - late;
    const during = [...new Set([...ended.filter((s) => s.to! >= from), ...open.values()].filter((s) => s.from <= now).map((s) => s.route))];
    const held = reads.map((r) => ({ afterMs: Math.round(r.heldMs), frames: r.frames }));
    const m = memory();
    const stall: EventLoopStall = {
      at: o.clock.now().toISOString(), ms: Math.round(late), during, ...(store ? { store } : {}), ...(processes ? { processes } : {}), ...(held.length ? { held } : {}),
      memory: { rssMb: mib(m.rss), heapMb: mib(m.heapUsed) },
    };
    last = { stall, seen: now };
    o.warn(`hopper: the event loop stalled for ${seconds(late)}; requests in flight: ${during.length ? during.join(', ') : 'none (a timer or the engine held it)'}${o.storeCalls ? storeLine(store) : ''}${processLine(processes)}${heldLine(stall.held)}; memory: ${stall.memory!.rssMb} MiB resident, ${stall.memory!.heapMb} MiB heap`);
    if (!o.raise) return;
    if (raised !== undefined && now - raised < raiseEveryMs) { skipped++; return; }
    raised = now;
    const told = { ...stall, skipped };
    skipped = 0;
    try { o.raise(told); } catch (e) { o.warn(`hopper: the event loop stall could not be raised: ${(e as Error).message}`); }
  };
  timer.unref();
  // The held thread ends on its own time: a close never waits on it.
  app.addHook('onClose', async () => { clearInterval(timer); delay.disable(); void o.held?.end().catch(() => undefined); });

  return {
    reading: () => {
      const m = memory();
      // A minute that ended, unless the one going on held the loop longer: a stall shows at once.
      const going = loopNow(), loop = window.read && window.read.delayMs.max >= going.delayMs.max ? window.read : going;
      return {
        uptimeS: Math.floor(process.uptime()),
        memory: { rssMb: mib(m.rss), heapUsedMb: mib(m.heapUsed), heapTotalMb: mib(m.heapTotal ?? 0), externalMb: mib(m.external ?? 0), arrayBuffersMb: mib(m.arrayBuffers ?? 0) },
        eventLoop: loop,
      };
    },
    last: () => (last && performance.now() - last.seen < STALL_SHOWN_MS ? last.stall : undefined),
    heldSince: (from) => {
      // The stall going on now, not yet seen by the timer: this read runs as the loop is freed.
      const going = performance.now() - at - tickMs, wall = Date.now();
      const spans = going >= stallMs ? [...stalls, { from: wall - going, to: wall }] : stalls;
      return Math.round(spans.reduce((n, s) => n + Math.max(0, s.to - Math.max(s.from, from)), 0));
    },
  };
}
