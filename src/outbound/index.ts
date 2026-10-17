// The outbound guard and the send log (issue #1014, design.md "Outbound sends"). The guard is one per process, so every
// user's sends to one destination share its limit: a token bucket, a dedupe of the sends that name a key, and a circuit
// that opens when a runaway asks more than the limits allow. Each user's sends go through that user's `Outbound`, which
// writes them to the user's send log: a sent or failed POST one row each, a held send one row, and its repeats within a
// minute counted on one more row. The URL stays in memory: the log and the lines name the host only. The dedupe keys are
// kept in the database (issue #1627), as a hash of the destination and the key, so a restart or a second host on the
// same database knows a send asked before; the rate buckets and the circuits stay this process's.
import { createHash } from 'node:crypto';
import { askDestination, freshDestination, hostOf, OUTBOUND_LIMITS, OUTBOUND_LOG_DAYS, takeToken, type DestinationState, type OutboundCircuit, type OutboundKeyRepository, type OutboundLimits, type OutboundOutcome, type OutboundSend, type OutboundSender, type OutboundSendRepository } from '../domain/outbound.ts';
import type { Clock } from '../domain/ports.ts';

/** A send: who makes it, to where, about what. `key`: the same key asked again within the dedupe window is a duplicate. */
export interface OutboundRequest {
  sender: OutboundSender;
  name: string;
  url: string;
  kind: string;
  jobId?: string;
  key?: string;
}

/** What a POST got: the receiver's status, and the error when it is no 2xx. */
export interface PostResult { status?: number; error?: string }

export type Held = Exclude<OutboundOutcome, 'sent' | 'failed'>;

export interface OutboundGuard {
  /** A new send asked: `ok`, or why it is held. Counts toward the destination's runaway. */
  ask(r: OutboundRequest): 'ok' | 'duplicate' | 'circuit-open';
  /** A token for one POST to `url`: 0 when taken, else the ms until one is free. */
  take(url: string): number;
  /** Whether the circuit of `url`'s destination is open now. */
  isOpen(url: string): boolean;
  /** The open circuits among `urls`' destinations. */
  circuits(urls: Iterable<string>): OutboundCircuit[];
}

export interface OutboundGuardOptions {
  clock: Clock;
  logger: { info(line: string): void; warn(line: string): void };
  limits?: Partial<OutboundLimits>;
  /** The dedupe keys in the database (issue #1627); none (a notifier built alone, a test): in this process only. */
  keys?: OutboundKeyRepository;
}

/** Above this many known keys, the expired ones are dropped. */
const KEYS_SWEEP_AT = 5000;
/** How often the ended keys are pruned from the database. */
const KEYS_PRUNE_MS = 10 * 60_000;

export function createOutboundGuard(o: OutboundGuardOptions): OutboundGuard {
  const limits: OutboundLimits = { ...OUTBOUND_LIMITS, ...o.limits };
  const destinations = new Map<string, DestinationState>();
  /** The dedupe keys asked, per destination, and until when each is known. */
  const keys = new Map<string, number>();
  const now = () => o.clock.now().getTime();
  const state = (url: string, t: number): DestinationState => destinations.get(url) ?? freshDestination(t, limits);
  let prunedAt = 0;

  function known(url: string, key: string, t: number): boolean {
    const k = `${url}\0${key}`;
    if (o.keys) {
      try {
        if (t - prunedAt >= KEYS_PRUNE_MS) { prunedAt = t; o.keys.prune(new Date(t).toISOString()); }
        return !o.keys.claim(createHash('sha256').update(k).digest('hex'), new Date(t + limits.dedupeMs).toISOString(), new Date(t).toISOString());
      } catch (e) {
        o.logger.warn(`hopper: outbound: the dedupe keys in the database: ${(e as Error).message}; this process's only meanwhile`);
      }
    }
    if ((keys.get(k) ?? 0) > t) return true;
    if (keys.size >= KEYS_SWEEP_AT) for (const [kk, until] of keys) if (until <= t) keys.delete(kk);
    keys.set(k, t + limits.dedupeMs);
    return false;
  }

  return {
    ask(r) {
      const t = now();
      const s = state(r.url, t);
      if (t < s.openUntil) return 'circuit-open';
      if (r.key !== undefined && known(r.url, r.key, t)) return 'duplicate';
      const a = askDestination(s, t, limits);
      destinations.set(r.url, a.state);
      if (a.opened) {
        o.logger.warn(`hopper: outbound: circuit open for ${hostOf(r.url)} until ${new Date(a.state.openUntil).toISOString()}: more than ${limits.runawayAsks} sends asked in ${limits.runawayWindowMs / 1000} s (the last: ${r.sender} ${r.name} ${r.kind}${r.jobId ? ` job ${r.jobId}` : ''}); nothing is sent to it meanwhile`);
      }
      return a.open ? 'circuit-open' : 'ok';
    },
    take(url) {
      const t = now();
      const s = takeToken(state(url, t), t, limits);
      destinations.set(url, s.state);
      return s.waitMs;
    },
    isOpen: (url) => now() < (destinations.get(url)?.openUntil ?? 0),
    circuits(urls) {
      const t = now();
      const open = new Map<string, number>();
      for (const url of urls) {
        const until = destinations.get(url)?.openUntil ?? 0;
        if (until > t) open.set(hostOf(url), Math.max(until, open.get(hostOf(url)) ?? 0));
      }
      return [...open].map(([host, until]) => ({ host, until: new Date(until).toISOString() }));
    },
  };
}

/** One user's sends: through the process's guard, into the user's send log. */
export interface Outbound {
  /** A new send asked: `ok`, or why it is held (that is logged). */
  ask(r: OutboundRequest): 'ok' | 'duplicate' | 'circuit-open';
  /** A token for one POST of `r`: 0 when taken, else the ms until one is free. Logs nothing. */
  take(r: OutboundRequest): number;
  isOpen(r: OutboundRequest): boolean;
  /** Log a send the guard held. */
  held(r: OutboundRequest, outcome: Held): void;
  /** Log one POST's result. */
  posted(r: OutboundRequest, result: PostResult): void;
  /**
   * One send whole: ask, take a token, POST, log. Held, nothing is posted: `held` says why. One attempt, no retry: a
   * caller that retries calls `take` and `posted` for each.
   */
  send(r: OutboundRequest, post: () => Promise<PostResult>): Promise<PostResult & { held?: Held }>;
  /** The open circuits of the destinations this user sent to. */
  circuits(): OutboundCircuit[];
  /** Write the counts not written yet; stop the minute's flush. */
  stop(): void;
}

export interface OutboundOptions {
  guard: OutboundGuard;
  clock: Clock;
  /** The user's send log; none (a notifier built alone, a test) logs nothing. */
  log?: OutboundSendRepository;
  /** How often the counts of held repeats are written, and old rows pruned. Default a minute. */
  flushMs?: number;
}

/** How often old rows are pruned. */
const PRUNE_MS = 60 * 60_000;

export function createOutbound(o: OutboundOptions): Outbound {
  const { guard, clock, log } = o;
  const urls = new Set<string>();
  /** Held repeats not written yet: the row they will be, by what they share. */
  const repeats = new Map<string, OutboundSend>();
  let prunedAt = 0;

  const row = (r: OutboundRequest, outcome: OutboundOutcome, extra: Partial<OutboundSend> = {}): OutboundSend => ({
    at: clock.now().toISOString(), sender: r.sender, name: r.name, host: hostOf(r.url), kind: r.kind, outcome, count: 1,
    ...(r.jobId ? { jobId: r.jobId } : {}), ...extra,
  });
  const write = (s: OutboundSend): void => {
    try { log?.add(s); } catch (e) { console.error('outbound: send log write failed', e); }
  };

  function held(r: OutboundRequest, outcome: Held): void {
    const k = [r.sender, r.name, hostOf(r.url), r.kind, outcome].join('\0');
    const waiting = repeats.get(k);
    if (waiting) { waiting.count++; return; }
    write(row(r, outcome));
    repeats.set(k, row(r, outcome, { count: 0 }));
  }

  function flush(): void {
    const at = clock.now().toISOString();
    for (const s of repeats.values()) if (s.count > 0) write({ ...s, at });
    repeats.clear();
    const t = clock.now().getTime();
    if (log && t - prunedAt >= PRUNE_MS) {
      prunedAt = t;
      try { log.prune(new Date(t - OUTBOUND_LOG_DAYS * 86_400_000).toISOString()); } catch (e) { console.error('outbound: send log prune failed', e); }
    }
  }
  const timer = setInterval(flush, o.flushMs ?? 60_000);
  timer.unref();

  const outbound: Outbound = {
    ask(r) {
      urls.add(r.url);
      const a = guard.ask(r);
      if (a !== 'ok') held(r, a);
      return a;
    },
    take: (r) => guard.take(r.url),
    isOpen: (r) => guard.isOpen(r.url),
    held,
    posted(r, result) {
      const ok = result.error === undefined && result.status !== undefined && result.status >= 200 && result.status < 300;
      write(row(r, ok ? 'sent' : 'failed', {
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(ok ? {} : { error: result.error ?? `HTTP ${result.status}` }),
      }));
    },
    async send(r, post) {
      const a = outbound.ask(r);
      if (a !== 'ok') return { held: a, error: heldWhy(a) };
      if (guard.take(r.url) > 0) { held(r, 'rate-limited'); return { held: 'rate-limited', error: heldWhy('rate-limited') }; }
      const result = await post();
      outbound.posted(r, result);
      return result;
    },
    circuits: () => guard.circuits(urls),
    stop() {
      clearInterval(timer);
      flush();
    },
  };
  return outbound;
}

/** Why a held send was not sent, as a delivery's or an action's error says it. */
export function heldWhy(h: Held): string {
  if (h === 'duplicate') return 'not sent: a duplicate of a send made within the dedupe window';
  if (h === 'circuit-open') return 'not sent: the destination\'s circuit is open (a runaway)';
  return 'not sent: the destination\'s rate limit';
}
