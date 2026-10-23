// The hopper's own disk use on a Machines card, and the disk budget an admin sets there (issue #1120, design.md "Hopper's
// own disk use" → "Part 2"). The budget is in GB in the form and in bytes on the wire. Pure.
import type { CacheKind, CacheUse, ContainerStorage, DiskBudget, HopperDisk, JobDiskUse } from '../../../src/domain/types.ts';
import type { MachineCleanupLeftovers } from '../../../src/domain/resource-ledger.ts';

const size = (bytes: number): string => (bytes >= 1e9 ? `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

/** The hopper's disk use on a machine, and its budget when there is one. */
export function hopperDiskText(d: HopperDisk): string {
  if (d.budgetBytes === undefined) return `${size(d.bytes)}, no budget`;
  return d.over ? `${size(d.bytes)}: over its ${size(d.budgetBytes)} budget` : `${size(d.bytes)} of its ${size(d.budgetBytes)} budget`;
}

const CACHE_NAMES: Record<CacheKind, string> = { nuget: 'NuGet', gradle: 'Gradle', go: 'Go', npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', pip: 'pip', cache: 'other ~/.cache' };

/** The machine's caches (issue #2494), each kind with its size, biggest first; undefined when none was measured. */
export function cachesText(caches: readonly CacheUse[] | undefined): string | undefined {
  if (!caches?.length) return undefined;
  return [...caches].sort((a, b) => b.bytes - a.bytes).map((c) => `${CACHE_NAMES[c.kind]} ${size(c.bytes)}`).join(' · ');
}

/** Each container runtime's storage (issue #2494), each kind that holds anything, with what it could reclaim; undefined when none. */
export function storageText(storage: readonly ContainerStorage[] | undefined): string | undefined {
  const used = (storage ?? []).filter((s) => s.bytes > 0);
  if (used.length === 0) return undefined;
  const runtimes = [...new Set(used.map((s) => s.runtime))];
  return runtimes.map((rt) => `${rt}: ${used.filter((s) => s.runtime === rt)
    .map((s) => `${s.kind.replace('-', ' ')} ${size(s.bytes)}${s.reclaimableBytes > 0 ? ` (${size(s.reclaimableBytes)} reclaimable)` : ''}`).join(', ')}`).join(' · ');
}

/** The jobs that take the most on a machine (issue #2494), the three biggest with their sizes; undefined when none was measured. */
export function jobsDiskText(jobs: readonly JobDiskUse[] | undefined): string | undefined {
  if (!jobs?.length) return undefined;
  const sorted = [...jobs].sort((a, b) => b.bytes - a.bytes), more = sorted.length - 3;
  return `${sorted.slice(0, 3).map((j) => `${j.jobId} ${size(j.bytes)}`).join(' · ')}${more > 0 ? `, and ${more} more` : ''}`;
}

const REFUSED = 'The budget must be a number of GB above 0, or empty for none';

/** What POST /ui/api/machines/disk-budget is sent for the form's GB, or why not. Empty: no budget. */
export function budgetBody(text: string): { budget: DiskBudget | null } | string {
  const t = text.trim();
  if (t === '') return { budget: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return REFUSED;
  return { budget: { bytes: Math.round(n * 1e9) } };
}

/** The form's GB for the budget set; empty when there is none. */
export const budgetDraft = (b: DiskBudget | null): string => (b ? String(b.bytes / 1e9) : '');

/**
 * The cleanup leftovers on a machine (issue #2504 part 3): what ended jobs left there after the grace period, and what it holds
 * on disk as the sweep last measured it, with the jobs the measure did not name (part 10).
 */
export function cleanupLeftoversText(l: MachineCleanupLeftovers): string {
  const n = (k: number, what: string): string => `${k} ${what}${k === 1 ? '' : 's'}`;
  const disk = [...(l.bytes !== undefined ? [`${size(l.bytes)} on disk`] : []), ...(l.unmeasured ? [`${n(l.unmeasured, 'job')} not measured`] : [])];
  return `${n(l.entries, 'thing')} of ${n(l.jobs, 'ended job')}, ${l.failed > 0 ? `${n(l.failed, 'removal')} failed: see Failures` : 'not removed yet'}${disk.length ? `; ${disk.join(', ')}` : ''}`;
}
