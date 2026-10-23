// The sweep's dry run and the disk budget of each machine (issue #2494, design.md "Hopper's own disk use" → "Part 14"), pure.
// On a machine whose `sweep.dryRun` is on, the sweep removes nothing: it says what a pass would remove there — the ended
// jobs' scratch dirs and worktrees it would reap, with what each takes; the jobs whose processes and containers it would
// stop; the storage prune, the caches over their caps and the trim it would run. The sweep records it as one
// machine.sweep_dry_run event, and again only once it changes.
import type { DiskBudget, SurveyedCache } from './hopper-disk.ts';
import type { SweepSettings } from './machines.ts';
import type { Survey } from './ports.ts';
import { cachesToClear } from './cache-caps.ts';
import { containersToPrune } from './storage-prune.ts';

const GIB = 1024 ** 3;

/** A machine's disk budget: its own `budgetGiB` (the `diskBudgetGiB` option), else the user's disk budget, else none. */
export const budgetOf = (s: SweepSettings | undefined, user: DiskBudget | undefined): DiskBudget | undefined =>
  (s?.budgetGiB !== undefined ? { bytes: Math.round(s.budgetGiB * GIB) } : user);

/** What one pass of the sweep would remove on a machine in dry run. */
export interface SweepDryRun {
  machineId: string;
  /** The ended jobs whose scratch dir (and job worktrees) it would reap, with what they take when measured; `kept`: work kept before, which the reap keeps while it is not pushed. */
  reaps: { jobId: string; scratch: string; bytes?: number; kept?: true }[];
  /** What those reaps would free: the bytes of each one not `kept`. */
  reapBytes: number;
  /** The jobs that are no longer live whose processes, scope and labelled containers it would stop and remove. */
  stops: string[];
  /** The storage prune (`pruneAfterDays`): the exited containers it would remove, and what the runtimes say they could reclaim of images, containers and volumes, at most. */
  prune?: { olderThanDays: number; containers: string[]; reclaimableBytes: number };
  /** The cache places it would clear (`cacheCapsGiB`), and their sum. */
  caches?: SurveyedCache[];
  cacheBytes: number;
  /** The trim (`trimAboveGiB`): `due` when the bytes above reach it. */
  trim?: { aboveGiB: number; due: boolean };
}

/** What a pass would remove on machine `m`, from its survey `found` and the sweep's plan; `kept`: the jobs whose work was kept before. */
export function dryRunOf(m: { id: string; sweep?: SweepSettings; disk?: { freeBytes: number; totalBytes: number; low: boolean } }, found: Survey, plan: readonly { jobId: string; scratch?: string }[],
  kept: ReadonlySet<string>, nowMs: number): SweepDryRun {
  const s = m.sweep;
  const reaps = plan.flatMap((r) => {
    if (r.scratch === undefined) return [];
    const of = (found.jobs ?? []).filter((j) => j.jobId === r.jobId);
    return [{ jobId: r.jobId, scratch: r.scratch, ...(of.length ? { bytes: of.reduce((n, j) => n + j.bytes, 0) } : {}), ...(kept.has(r.jobId) ? { kept: true as const } : {}) }];
  });
  const reapBytes = reaps.reduce((n, r) => n + (r.kept ? 0 : r.bytes ?? 0), 0);
  const prune = s?.pruneAfterDays ? {
    olderThanDays: s.pruneAfterDays, containers: containersToPrune(found.exited ?? [], s.pruneAfterDays, nowMs).map((x) => `${x.runtime}:${x.id}`),
    reclaimableBytes: (found.storage ?? []).filter((x) => x.kind !== 'build-cache').reduce((n, x) => n + x.reclaimableBytes, 0),
  } : undefined;
  const kinds: readonly string[] = cachesToClear(s?.cacheCapsGiB, found.caches ?? [], m.disk?.low === true);
  const caches = (found.caches ?? []).filter((x) => kinds.includes(x.kind));
  const cacheBytes = caches.reduce((n, x) => n + x.bytes, 0);
  return {
    machineId: m.id, reaps, reapBytes, stops: plan.filter((r) => r.scratch === undefined).map((r) => r.jobId),
    ...(prune ? { prune } : {}), ...(caches.length ? { caches } : {}), cacheBytes,
    ...(s?.trimAboveGiB ? { trim: { aboveGiB: s.trimAboveGiB, due: reapBytes + cacheBytes + (prune?.reclaimableBytes ?? 0) >= s.trimAboveGiB * GIB } } : {}),
  };
}
