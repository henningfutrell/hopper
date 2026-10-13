// Outbound sends (issue #1014, design.md "Outbound sends"): every POST the hopper makes to a webhook — a webhook
// subscription's delivery, the Grok Bot routine notifier's post — passes the outbound guard of its destination: a rate
// limit, a dedupe, and a circuit that opens on a runaway. Each send, and each send the guard held, goes into the user's
// send log. Types and the guard's arithmetic, pure: the time is passed in.

/** Who made the send: a webhook subscription's delivery, or a notifier's post. */
export type OutboundSender = 'webhook' | 'notifier';

/**
 * What became of a send: `sent` (a 2xx answered), `failed` (another answer, or none), or held by the guard and never
 * posted — `rate-limited` (no token), `duplicate` (the same send asked within the dedupe window), `circuit-open`.
 */
export type OutboundOutcome = 'sent' | 'failed' | 'rate-limited' | 'duplicate' | 'circuit-open';

export const OUTBOUND_OUTCOMES: readonly OutboundOutcome[] = ['sent', 'failed', 'rate-limited', 'duplicate', 'circuit-open'];

/** One row of the send log. */
export interface OutboundSend {
  at: string;
  sender: OutboundSender;
  /** The webhook subscription's name, or the notifier instance's. */
  name: string;
  /** The destination's host only: never its path or query, which can carry a secret (a routine's URL is one). */
  host: string;
  /** The event type, or the notifier's kind (`hopper.reachable`, `test`). */
  kind: string;
  outcome: OutboundOutcome;
  /** How many sends the row stands for: a held send that repeats within a minute is counted on one row. */
  count: number;
  status?: number;
  error?: string;
  jobId?: string;
}

/** The send log, in the user's store (tenant table `outbound_sends`). */
export interface OutboundSendRepository {
  add(s: OutboundSend): void;
  /** Newest first; only the sends of `name` when given. */
  list(o: { limit: number; name?: string }): OutboundSend[];
  /** Remove the rows from before `before` (ISO); answers how many. */
  prune(before: string): number;
}

/** A destination whose circuit is open: nothing is sent to it until `until`. */
export interface OutboundCircuit { host: string; until: string }

export interface OutboundLimits {
  /** Sends a destination may take at once. */
  burst: number;
  /** Sends a destination gets back per second, up to `burst`. */
  perSecond: number;
  /** How long a send with a dedupe key is known: the same key asked again within it is a duplicate. */
  dedupeMs: number;
  /** More new sends asked of one destination than this within `runawayWindowMs` is a runaway: its circuit opens. */
  runawayAsks: number;
  runawayWindowMs: number;
  /** How long an open circuit stays open. */
  openMs: number;
}

export const OUTBOUND_LIMITS: OutboundLimits = {
  burst: 60, perSecond: 5, dedupeMs: 10 * 60_000, runawayAsks: 600, runawayWindowMs: 60_000, openMs: 5 * 60_000,
};

/** How long the send log keeps a row. */
export const OUTBOUND_LOG_DAYS = 14;

/** One destination's guard state; times in ms. */
export interface DestinationState { tokens: number; refilledAt: number; windowStart: number; asks: number; openUntil: number }

export const freshDestination = (now: number, l: OutboundLimits): DestinationState =>
  ({ tokens: l.burst, refilledAt: now, windowStart: now, asks: 0, openUntil: 0 });

/** A new send asked of the destination at `now`: whether its circuit is open, and whether this ask opened it. */
export function askDestination(s: DestinationState, now: number, l: OutboundLimits): { state: DestinationState; open: boolean; opened: boolean } {
  if (now < s.openUntil) return { state: s, open: true, opened: false };
  const fresh = now - s.windowStart >= l.runawayWindowMs;
  const asks = (fresh ? 0 : s.asks) + 1;
  const windowStart = fresh ? now : s.windowStart;
  if (asks > l.runawayAsks) return { state: { ...s, asks: 0, windowStart: now, openUntil: now + l.openMs }, open: true, opened: true };
  return { state: { ...s, asks, windowStart }, open: false, opened: false };
}

/** One token for one POST at `now`: `waitMs` 0 when taken, else how long until one is free. */
export function takeToken(s: DestinationState, now: number, l: OutboundLimits): { state: DestinationState; waitMs: number } {
  const tokens = Math.min(l.burst, s.tokens + (Math.max(0, now - s.refilledAt) / 1000) * l.perSecond);
  if (tokens >= 1) return { state: { ...s, tokens: tokens - 1, refilledAt: now }, waitMs: 0 };
  return { state: { ...s, tokens, refilledAt: now }, waitMs: Math.ceil(((1 - tokens) / l.perSecond) * 1000) };
}

/** The send log's name for a destination: its host, never its path or query. */
export function hostOf(url: string): string {
  try { return new URL(url).host || 'unknown'; } catch { return 'invalid URL'; }
}
