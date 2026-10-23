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

/** One job's scratch dir or one of its worktrees, as the survey measured it on its own (issue #2494). */
export interface SurveyedJobDisk { jobId: string; kind: 'scratch' | 'tree'; path: string; bytes: number }

/** What one job takes on a machine (issue #2494): its worktrees and its scratch dir, and their sum. */
export interface JobDiskUse { jobId: string; bytes: number; worktreeBytes: number; scratchBytes: number }

/** How many jobs a measure keeps (issue #2494): the biggest only, so a machine with many jobs left keeps a short measure. */
export const KEPT_JOB_DISKS = 50;

/**
 * The hopper's own disk use on one machine, as the sweep last measured it (issue #1120): the bytes of each place, their
 * sum, and when. `budgetBytes`: the disk budget now, absent when there is none; `over`: the use is more than it.
 * `caches`, `storage` (issue #2494): the machine's caches and its container storage, absent when not measured.
 * `jobs` (issue #2494): what each job there takes, biggest first, at most KEPT_JOB_DISKS; absent when not measured.
 */
export interface HopperDisk { bytes: number; at: string; paths: HopperDiskPath[]; budgetBytes?: number; over: boolean; caches?: CacheUse[]; storage?: ContainerStorage[]; jobs?: JobDiskUse[] }

/**
 * What the sweep last measured on one machine (issue #2494), as the store keeps it: its places, when, and its caches and
 * container storage as the survey said them, and what each job takes. The disk budget is applied at each read, so a new
 * budget needs no new measure.
 */
export interface DiskMeasure { at: string; paths: HopperDiskPath[]; caches?: SurveyedCache[]; storage?: ContainerStorage[]; jobs?: JobDiskUse[] }

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

/** What each job takes (issue #2494): its places summed, biggest first, the KEPT_JOB_DISKS biggest only. */
export function jobDiskOf(found: readonly SurveyedJobDisk[]): JobDiskUse[] {
  const byJob = new Map<string, JobDiskUse>();
  for (const f of found) {
    const use = byJob.get(f.jobId) ?? { jobId: f.jobId, bytes: 0, worktreeBytes: 0, scratchBytes: 0 };
    byJob.set(f.jobId, { ...use, bytes: use.bytes + f.bytes, ...(f.kind === 'tree' ? { worktreeBytes: use.worktreeBytes + f.bytes } : { scratchBytes: use.scratchBytes + f.bytes }) });
  }
  return [...byJob.values()].sort((a, b) => b.bytes - a.bytes).slice(0, KEPT_JOB_DISKS);
}

/** The hopper's disk use from what a survey measured, at `at`, against `budget`; undefined when it measured nothing. */
export function hopperDiskOf(paths: readonly HopperDiskPath[] | undefined, at: string, budget: DiskBudget | undefined,
  more: { caches?: readonly SurveyedCache[]; storage?: readonly ContainerStorage[]; jobs?: readonly JobDiskUse[] } = {}): HopperDisk | undefined {
  const caches = more.caches?.length ? cacheUseOf(more.caches) : undefined;
  const storage = more.storage?.length ? [...more.storage] : undefined;
  const jobs = more.jobs?.length ? [...more.jobs] : undefined;
  if (!paths?.length && !caches && !storage) return undefined;
  const bytes = (paths ?? []).reduce((sum, p) => sum + p.bytes, 0);
  return { bytes, at, paths: [...(paths ?? [])], ...(budget ? { budgetBytes: budget.bytes } : {}), over: budget !== undefined && bytes > budget.bytes,
    ...(caches ? { caches } : {}), ...(storage ? { storage } : {}), ...(jobs ? { jobs } : {}) };
}

/** A disk measure older than this is not in a machine sample or a disk gauge (issue #2494): the sweep measures every 10 minutes. */
export const DISK_MEASURE_FRESH_MS = 3_600_000;

/** The measure, when it is at most DISK_MEASURE_FRESH_MS older than `at`; else undefined. */
export const freshMeasure = (m: DiskMeasure | undefined, at: string): DiskMeasure | undefined =>
  (m && Date.parse(at) - Date.parse(m.at) <= DISK_MEASURE_FRESH_MS ? m : undefined);

/** What a measure says the hopper's own places take, and the caches (each counted once); `caches` undefined when none measured. */
export function diskUseOf(m: DiskMeasure): { hopperBytes: number; cacheBytes?: number } {
  const caches = m.caches?.length ? cacheUseOf(m.caches).reduce((n, c) => n + c.bytes, 0) : undefined;
  return { hopperBytes: m.paths.reduce((n, p) => n + p.bytes, 0), ...(caches !== undefined ? { cacheBytes: caches } : {}) };
}
