// How the work after a person's act spent its time (issue #1194, design.md "Actions answer at once"). An act answers
// first; its slow work runs after, on a queue: the job's report chain (a give-back, Merge now, Close PR) or the source's
// sync chain (the sync an intake action asks for). Each run is kept as the time it waited on its queue apart from the
// time it ran, per act, so a slow act shows whether it waited behind other work or was slow itself. Kept in memory,
// the last SAMPLES runs of each act; served on GET /api/sources as `afterAnswer`.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AfterAnswerTiming, TimingSpread } from '../domain/types.ts';

/** The runs of each act kept for its spread. */
export const SAMPLES = 100;

const acts = new AsyncLocalStorage<string>();

/** Runs `fn` as the work of `act`: what it puts on a queue, through any await, is timed as that act's. */
export function withAct<T>(act: string, fn: () => T): T {
  return acts.run(act, fn);
}

/** The act whose work runs now, or undefined: work no person's act started (a timer, a report). */
export function actOf(): string | undefined {
  return acts.getStore();
}

export interface AfterAnswerTimings {
  record(act: string, waitMs: number, runMs: number): void;
  /** Each act timed, by name. */
  summary(): AfterAnswerTiming[];
}

export function createAfterAnswerTimings(now: () => Date): AfterAnswerTimings {
  const kept = new Map<string, { count: number; wait: number[]; run: number[]; lastAt: string }>();
  return {
    record(act, waitMs, runMs) {
      const k = kept.get(act) ?? { count: 0, wait: [], run: [], lastAt: '' };
      k.count++;
      k.wait.push(Math.round(waitMs));
      k.run.push(Math.round(runMs));
      if (k.wait.length > SAMPLES) { k.wait.shift(); k.run.shift(); }
      k.lastAt = now().toISOString();
      kept.set(act, k);
    },
    summary: () => [...kept].sort(([a], [b]) => a.localeCompare(b))
      .map(([act, k]) => ({ act, count: k.count, waitMs: spread(k.wait), runMs: spread(k.run), lastAt: k.lastAt })),
  };
}

/** p50, p95 (nearest rank) and max. */
function spread(xs: number[]): TimingSpread {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
}

/** A queued run of `fn`, timed as the act that queued it, if a person's act did. Call when it is queued. */
export function timed(timings: AfterAnswerTimings, fn: () => Promise<void>): () => Promise<void> {
  const act = actOf();
  if (act === undefined) return fn;
  const queuedAt = performance.now();
  return async () => {
    const startedAt = performance.now();
    try {
      await fn();
    } finally {
      timings.record(act, startedAt - queuedAt, performance.now() - startedAt);
    }
  };
}

/** A person's act that asked for a sync, and when (`performance.now()`). */
export interface SyncAsk { act: string; at: number }

/** The ask of a sync the act whose work runs now makes, timed as `sync:<act>` from `at` (the act's outbox send, issue #1238); none when no act runs. */
export function syncAsks(at = performance.now()): SyncAsk[] {
  const act = actOf();
  return act === undefined ? [] : [{ act: `sync:${act}`, at }];
}

/** Runs a queued sync, timed once for each act that asked for it, each wait from its own ask. */
export async function timedSync(timings: AfterAnswerTimings, asks: readonly SyncAsk[], sync: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  try {
    await sync();
  } finally {
    const ranMs = performance.now() - startedAt;
    for (const a of asks) timings.record(a.act, startedAt - a.at, ranMs);
  }
}
