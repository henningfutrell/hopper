// The cache caps (issue #2494, design.md "Hopper's own disk use" → "Part 10"), pure: which caches of a machine the sweep
// clears, and whether a job keeps it from doing so. The clear itself is src/client/caches.ts; the sweep runs it
// (src/engine/sweep-caches.ts).
import type { CacheKind, SurveyedCache } from './hopper-disk.ts';
import type { Job } from './types.ts';
import { TERMINAL_STATUSES } from './types.ts';
import { machineRanOn } from './kept-work.ts';

/** The kinds of cache a cap can be set for: each tool's own, never the rest of `~/.cache`. */
export const CAPPED_KINDS = ['nuget', 'gradle', 'go', 'npm', 'pnpm', 'yarn', 'pip'] as const satisfies readonly CacheKind[];
export type CappedKind = typeof CAPPED_KINDS[number];

/** The cap of each kind of cache on a machine, in GiB; a kind with none is never cleared. */
export type CacheCaps = Partial<Record<CappedKind, number>>;

/** One cache place a clear removed, with its size as the survey before it measured it. */
export interface ClearedCache { kind: CappedKind; path: string; bytes: number }
/** What a finished clear said it removed: the places, each by its kind. */
export interface Cleared { removed: { kind: CappedKind; path: string }[] }

const GIB = 1024 ** 3;

/**
 * The kinds to clear on a machine, from what its survey measured: each kind with a cap whose places take more than it,
 * or, while the machine's disk is `low`, each kind with a cap that takes anything.
 */
export function cachesToClear(caps: CacheCaps | undefined, caches: readonly SurveyedCache[], low: boolean): CappedKind[] {
  const out: CappedKind[] = [];
  for (const kind of CAPPED_KINDS) {
    const cap = caps?.[kind];
    if (cap === undefined) continue;
    const bytes = caches.filter((c) => c.kind === kind).reduce((n, c) => n + c.bytes, 0);
    if (bytes > cap * GIB || (low && bytes > 0)) out.push(kind);
  }
  return out;
}

/**
 * Why no cache may be cleared on the machine now; undefined when nothing keeps it. A job there that has not ended — claimed,
 * running, waiting, parked, led by an operator, or queued for it —, or a scope or process of any job the survey found
 * there, may use its caches.
 */
export function cachesInUse(machineId: string, jobs: readonly Job[], running: readonly string[]): string | undefined {
  const job = jobs.find((j) => !TERMINAL_STATUSES.includes(j.status) && machineRanOn(j) === machineId);
  if (job) return `job ${job.id} is ${job.status} there`;
  return running.length > 0 ? `job ${running[0]} runs there` : undefined;
}
