// The hopper's own disk use on a machine (issue #1120, design.md "Hopper's own disk use" → "Part 2"): what the sweep's
// survey measured of the places the hopper keeps things in each work tree — its scratch area and its job worktrees —,
// held against the disk budget, the most the user lets it be on one machine. Beside it (issue #2494, "Part 6"), what the
// machine's caches and its container storage take, which the budget does not count. Pure.

/** One place the hopper keeps things on a machine, as the survey measured it: a work tree's scratch area or its job worktrees. */
export interface HopperDiskPath { path: string; bytes: number }

/** A kind of cache the tools keep in a machine's home (issue #2494); `cache` is the rest of `~/.cache`. */
export const CACHE_KINDS = ['nuget', 'gradle', 'go', 'npm', 'pnpm', 'yarn', 'pip', 'cache'] as const;
export type CacheKind = typeof CACHE_KINDS[number];

/** One cache place as the survey measured it (issue #2494). `cache`'s bytes hold the other kinds' places in it too. */
export interface SurveyedCache { kind: CacheKind; path: string; bytes: number }

/** What one kind of cache takes on a machine (issue #2494): its places and their sum. */
export interface CacheUse { kind: CacheKind; bytes: number; paths: string[] }

/** What one container runtime's storage of one kind takes on a machine, as its `system df` says (issue #2494). */
export interface ContainerStorage { runtime: 'docker' | 'podman'; kind: 'images' | 'containers' | 'volumes' | 'build-cache'; bytes: number; reclaimableBytes: number }

/**
 * The hopper's own disk use on one machine, as the sweep last measured it (issue #1120): the bytes of each place, their
 * sum, and when. `budgetBytes`: the disk budget now, absent when there is none; `over`: the use is more than it.
 * `caches`, `storage` (issue #2494): the machine's caches and its container storage, absent when not measured.
 */
export interface HopperDisk { bytes: number; at: string; paths: HopperDiskPath[]; budgetBytes?: number; over: boolean; caches?: CacheUse[]; storage?: ContainerStorage[] }

/**
 * What the sweep last measured on one machine (issue #2494), as the store keeps it: its places, when, and its caches and
 * container storage as the survey said them. The disk budget is applied at each read, so a new budget needs no new measure.
 */
export interface DiskMeasure { at: string; paths: HopperDiskPath[]; caches?: SurveyedCache[]; storage?: ContainerStorage[] }

/** Each machine's last disk measure (issue #2494, tenant migration 94): one per machine, the newest replaces the one before. */
export interface DiskMeasureRepository {
  keep(machineId: string, measure: DiskMeasure): void;
  /** Every machine's last measure. */
  all(): Array<[string, DiskMeasure]>;
}

/** The disk budget (issue #1120): the most the hopper's own disk use may be on each machine. The user's setting, an admin's to change. */
export interface DiskBudget { bytes: number }

/** The budget events, by type. */
export const BUDGET_EVENTS = ['machine.disk_over_budget', 'machine.disk_within_budget'] as const;

/** The machines whose newest budget event (newest first, as the event log reads them) told them over the disk budget (issue #2494). */
export function overBudgetTold(events: readonly { type: string; machineId?: string }[]): Set<string> {
  const seen = new Set<string>(), over = new Set<string>();
  for (const e of events) {
    if (!e.machineId || seen.has(e.machineId)) continue;
    seen.add(e.machineId);
    if (e.type === 'machine.disk_over_budget') over.add(e.machineId);
  }
  return over;
}

/** Each kind of cache, its places summed, biggest first; the rest of `~/.cache` less the other kinds' places in it. */
export function cacheUseOf(found: readonly SurveyedCache[]): CacheUse[] {
  const rest = (c: SurveyedCache): number => (c.kind !== 'cache' ? c.bytes
    : Math.max(0, c.bytes - found.filter((o) => o.kind !== 'cache' && o.path.startsWith(`${c.path}/`)).reduce((s, o) => s + o.bytes, 0)));
  const byKind = new Map<CacheKind, CacheUse>();
  for (const c of found) {
    const use = byKind.get(c.kind) ?? { kind: c.kind, bytes: 0, paths: [] };
    byKind.set(c.kind, { ...use, bytes: use.bytes + rest(c), paths: [...use.paths, c.path] });
  }
  return [...byKind.values()].sort((a, b) => b.bytes - a.bytes);
}

/** The hopper's disk use from what a survey measured, at `at`, against `budget`; undefined when it measured nothing. */
export function hopperDiskOf(paths: readonly HopperDiskPath[] | undefined, at: string, budget: DiskBudget | undefined,
  more: { caches?: readonly SurveyedCache[]; storage?: readonly ContainerStorage[] } = {}): HopperDisk | undefined {
  const caches = more.caches?.length ? cacheUseOf(more.caches) : undefined;
  const storage = more.storage?.length ? [...more.storage] : undefined;
  if (!paths?.length && !caches && !storage) return undefined;
  const bytes = (paths ?? []).reduce((sum, p) => sum + p.bytes, 0);
  return { bytes, at, paths: [...(paths ?? [])], ...(budget ? { budgetBytes: budget.bytes } : {}), over: budget !== undefined && bytes > budget.bytes,
    ...(caches ? { caches } : {}), ...(storage ? { storage } : {}) };
}
