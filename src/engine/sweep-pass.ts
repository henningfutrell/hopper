// The cleanup pass's record (issue #2494, design.md "Hopper's own disk use" → "Part 15"), the sweep's part beside sweep.ts
// for its size: each real pass of the sweep on a machine tallies what it did there — the scratch dirs and job worktrees its
// reaps removed, with the bytes the survey (or the reap) measured; the containers and volumes they removed of a job; what
// the storage prune and the cache caps removed, with their bytes; the work it kept, and why; the dirs it could not remove;
// and the fstrim result —, and records it as one machine.sweep_passed event. Only when the pass removed something, kept work
// or could not remove a dir for the first time, or trimmed: a pass that only keeps the same work again records nothing.
// A dry run records none (sweep-dry-run.ts says what it would remove). Each part logs what it did; the record logs nothing more.
import type { MachineSnapshot } from '../domain/types.ts';
import type { Reaped, Survey } from '../domain/ports.ts';
import { keptData, type KeptReason } from '../domain/kept-work.ts';
import type { TrimOutcome } from '../domain/disk-trim.ts';
import type { EngineContext } from './context.ts';

/** What a pass removed: `scratch`, ended jobs' scratch dirs with their job worktrees; `job-storage`, the containers and volumes labelled with a job; `storage`, the storage prune's; `caches`, the cache places cleared. */
export type PassRemovedKind = 'scratch' | 'job-storage' | 'storage' | 'caches';
export interface PassRemoved { kind: PassRemovedKind; count: number; bytes?: number }
/** The fstrim result of a pass, as machine.disk_trim_ran has it. */
export interface PassTrim { mount: string; outcome: TrimOutcome; trimmedBytes?: number; said?: string; hostCompaction?: true }

/** One pass's record on a machine, as machine.sweep_passed has it. */
export interface SweepPassed {
  machineId: string;
  removed: PassRemoved[];
  /** The sum of the bytes of `removed` that were measured. */
  freedBytes: number;
  /** The work the reaps kept, with why; `again`: kept by an earlier pass too. */
  kept: { jobId: string; paths: string[]; reasons?: Record<string, KeptReason[]>; again?: true }[];
  /** The dirs the reaps could not remove. */
  left?: { jobId: string; paths: string[] }[];
  trim?: PassTrim;
}

/** What one pass did on a machine, told as it happens, then recorded once. */
export interface PassTally {
  /** A reap of the job, as it said; `scratch`: it reaped the scratch dir; `before`: work kept, or a dir left, told before. */
  reaped(jobId: string, scratch: boolean, said: Reaped, before: boolean): void;
  /** What the storage prune or the cache caps removed. */
  add(kind: 'storage' | 'caches', did: { count: number; bytes: number }): void;
  trimmed(t: PassTrim | undefined): void;
  /** Records the pass as one machine.sweep_passed event, when it has news. */
  record(): void;
}

/** The tally of one real pass on machine `m`, whose survey `found` measured each job's dirs. */
export function passTally(c: Pick<EngineContext, 'store' | 'stopping'>, m: MachineSnapshot, found: Survey): PassTally {
  const removed = new Map<PassRemovedKind, PassRemoved>();
  const kept: SweepPassed['kept'] = [], left: NonNullable<SweepPassed['left']> = [];
  let news = false, trim: PassTrim | undefined;
  const add = (kind: PassRemovedKind, count: number, bytes?: number): void => {
    if (count === 0) return;
    const r = removed.get(kind) ?? { kind, count: 0 };
    r.count += count;
    if (bytes !== undefined) r.bytes = (r.bytes ?? 0) + bytes;
    removed.set(kind, r);
    news = true;
  };
  /** What the job's dirs took: as the reap measured it, else as the pass's survey did. */
  const bytesOf = (jobId: string, said: Reaped): number | undefined => {
    if (said.used?.diskBytes !== undefined) return said.used.diskBytes;
    const of = (found.jobs ?? []).filter((j) => j.jobId === jobId);
    return of.length ? of.reduce((n, j) => n + j.bytes, 0) : undefined;
  };
  return {
    reaped(jobId, scratch, said, before) {
      if (said.removed) add('job-storage', said.removed.containers.length + said.removed.volumes.length);
      if (!scratch) return;
      if (said.left?.length) {
        left.push({ jobId, paths: [...said.left] });
        news ||= !before;
      } else if (said.kept.length > 0) {
        kept.push({ jobId, ...keptData(said, said.kept), ...(before ? { again: true as const } : {}) });
        news ||= !before;
      } else add('scratch', 1, bytesOf(jobId, said));
    },
    add: (kind, did) => add(kind, did.count, did.bytes),
    trimmed(t) { if (t) { trim = t; news = true; } },
    record() {
      if (!news || c.stopping()) return;
      const order: PassRemovedKind[] = ['scratch', 'job-storage', 'storage', 'caches'];
      const list = order.flatMap((k) => (removed.has(k) ? [removed.get(k)!] : []));
      const freedBytes = list.reduce((n, r) => n + (r.bytes ?? 0), 0);
      const data: SweepPassed = { machineId: m.id, removed: list, freedBytes, kept, ...(left.length ? { left } : {}), ...(trim ? { trim } : {}) };
      c.store.events.append({ type: 'machine.sweep_passed', machineId: m.id, data: { ...data } });
    },
  };
}
