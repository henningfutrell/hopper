// A job's resource ledger (issue #2504, design.md "The resource ledger"): each thing the hopper made for a job on a machine —
// its scratch dir, its job worktree, its job scope —, recorded once the job's executor says it made it, and closed by the
// job's cleanup or by the sweep as each reap says: reaped, kept (work not pushed), or failed with why. A job's **cleanup
// status** is read from its entries and its cleanup record. Pure: no I/O, no clock — `at` is passed in.
import type { BomPart, BomStatus } from './job-bom.ts';
import { jobScratchOf } from './job-layout.ts';
import type { Reaped } from './machine-shell.ts';
import { TERMINAL_STATUSES, type Job } from './types.ts';

/** What a ledger entry is. */
export const LEDGER_KINDS = ['scratch_dir', 'job_worktree', 'job_scope'] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];

/** Where a ledger entry stands: still there, removed, kept for work not pushed, or a removal that failed. */
export const LEDGER_STATES = ['live', 'reaped', 'kept', 'failed'] as const;
export type LedgerState = typeof LEDGER_STATES[number];

/** One thing the hopper made for a job: on which machine, what, where (`locator`: a path or a unit name), and since when. */
export interface LedgerEntry {
  jobId: string;
  machineId: string;
  kind: LedgerKind;
  locator: string;
  createdAt: string;
  state: LedgerState;
  /** Why a removal failed; absent unless `failed`. */
  reason?: string;
  /** When it left `live`. */
  endedAt?: string;
}

/** A ledger entry before the store has it. */
export type NewLedgerEntry = Pick<LedgerEntry, 'jobId' | 'machineId' | 'kind' | 'locator' | 'createdAt'>;

export interface ResourceLedgerRepository {
  /** Records an entry as `live`; one already there (same job, kind and locator) is left as it is. */
  record(entry: NewLedgerEntry): void;
  /** Closes the job's entry of that kind and locator, unless it is `reaped`: a `kept` or `failed` one a later reap may close. */
  close(jobId: string, kind: LedgerKind, locator: string, state: Exclude<LedgerState, 'live'>, at: string, reason?: string): void;
  /** The job's entries, oldest first. */
  forJob(jobId: string): LedgerEntry[];
  /** Every entry still `live` or `failed`, of every job, by job then oldest first: what the leftover check reads. */
  open(): LedgerEntry[];
}

/**
 * A job's cleanup status: no entry; the job not ended, so what it has is in use; its cleanup owed (not reached, or an entry
 * still live); under way; done; done with work kept; or a removal failed.
 */
export const CLEANUP_STATUSES = ['none', 'in_use', 'pending', 'in_progress', 'done', 'kept_work', 'failed'] as const;
export type CleanupStatus = typeof CLEANUP_STATUSES[number];

/** The entries an executor's saved state names (`cwd`, `jobWorktree`, `scope`), on machine `machineId`. */
export function ledgerEntriesOf(jobId: string, machineId: string, state: unknown, at: string): NewLedgerEntry[] {
  const s = (state ?? {}) as { cwd?: unknown; jobWorktree?: unknown; scope?: unknown };
  const path = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/');
  const out: NewLedgerEntry[] = [];
  const add = (kind: LedgerKind, locator: string): void => { out.push({ jobId, machineId, kind, locator, createdAt: at }); };
  if (path(s.cwd)) add('scratch_dir', jobScratchOf(s.cwd, jobId));
  if (path(s.jobWorktree)) add('job_worktree', s.jobWorktree);
  if (typeof s.scope === 'string' && s.scope) add('job_scope', s.scope);
  return out;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * What a reap says of each live or kept entry: a dir it could not remove failed; with work kept, the scratch dir and the job
 * worktree are kept (the reap keeps them together); else each is reaped. A scope is always stopped. A reap that did not look
 * at the scratch dir (`scratch` false) judges the scope only. A reaped entry is not judged again; a failed one a later reap
 * removed is reaped.
 */
export function reapClosures(entries: readonly LedgerEntry[], said: Reaped, scratch = true): { entry: LedgerEntry; state: Exclude<LedgerState, 'live'>; reason?: string }[] {
  return entries.filter((e) => e.state !== 'reaped' && (scratch || e.kind === 'job_scope')).map((entry) => {
    if (entry.kind === 'job_scope') return { entry, state: 'reaped' as const };
    const left = said.left?.find((p) => within(p, entry.locator) || within(entry.locator, p));
    if (left) return { entry, state: 'failed' as const, reason: `${left} is still there` };
    return { entry, state: said.kept.length > 0 ? 'kept' as const : 'reaped' as const };
  }).filter((c) => c.state !== c.entry.state || c.reason !== c.entry.reason);
}

/** How long after a job ended an entry may stay `live` or `failed` before it is a **cleanup leftover** (issue #2504). */
export const CLEANUP_GRACE_MINUTES = 60;

/** An ended job's cleanup leftovers: its entries still `live` or `failed` once the grace period after its end passed. */
export interface CleanupLeftover { jobId: string; endedAt: string; entries: LedgerEntry[] }

/**
 * The cleanup leftovers in `open` (every entry still `live` or `failed`), by job: a job that ended more than
 * `CLEANUP_GRACE_MINUTES` before `now`; its end is when it finished, else when it last changed. A job the store does not
 * know is not judged here.
 */
export function cleanupLeftoversOf(open: readonly LedgerEntry[], jobOf: (id: string) => Pick<Job, 'status' | 'finishedAt' | 'updatedAt'> | undefined, now: number): CleanupLeftover[] {
  const byJob = new Map<string, LedgerEntry[]>();
  for (const e of open) if (e.state === 'live' || e.state === 'failed') (byJob.get(e.jobId) ?? byJob.set(e.jobId, []).get(e.jobId)!).push(e);
  const out: CleanupLeftover[] = [];
  for (const [jobId, entries] of byJob) {
    const job = jobOf(jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status)) continue;
    const endedAt = job.finishedAt ?? job.updatedAt;
    if (now - Date.parse(endedAt) >= CLEANUP_GRACE_MINUTES * 60_000) out.push({ jobId, endedAt, entries });
  }
  return out;
}

/** The job's cleanup status, from its entries and its cleanup record (`cleanupDue`, `cleanupDeferred`). */
export function cleanupStatusOf(job: Pick<Job, 'status' | 'cleanupDue' | 'cleanupDeferred'>, entries: readonly LedgerEntry[]): CleanupStatus {
  if (entries.length === 0) return 'none';
  if (!TERMINAL_STATUSES.includes(job.status)) return 'in_use';
  if (job.cleanupDeferred) return 'pending';
  if (job.cleanupDue) return 'in_progress';
  if (entries.some((e) => e.state === 'failed')) return 'failed';
  if (entries.some((e) => e.state === 'live')) return 'pending';
  return entries.some((e) => e.state === 'kept') ? 'kept_work' : 'done';
}

const KIND_WORDS: Record<LedgerKind, string> = { scratch_dir: 'Scratch dir', job_worktree: 'Job worktree', job_scope: 'Job scope' };
const STATE_WORDS: Record<LedgerState, string> = { live: 'still there', reaped: 'removed', kept: 'kept: it holds work not pushed', failed: 'not removed' };
const CLEANUP_PART: Record<Exclude<CleanupStatus, 'none'>, { status: BomStatus; label: string }> = {
  in_use: { status: 'running', label: 'Cleanup: the job still uses what it has' },
  pending: { status: 'open', label: 'Cleanup: owed' },
  in_progress: { status: 'running', label: 'Cleanup: under way' },
  done: { status: 'done', label: 'Cleanup: done' },
  kept_work: { status: 'open', label: 'Cleanup: done, work not pushed kept' },
  failed: { status: 'failed', label: 'Cleanup: failed' },
};

/**
 * The job's parts-list parts for its resource ledger (machines group): its cleanup status, then each entry — a record, but
 * one whose removal failed, which counts.
 */
export function ledgerParts(job: Pick<Job, 'status' | 'cleanupDue' | 'cleanupDeferred'>, entries: readonly LedgerEntry[]): BomPart[] {
  const status = cleanupStatusOf(job, entries);
  if (status === 'none') return [];
  const failed = entries.filter((e) => e.state === 'failed').length;
  return [
    { id: 'cleanup', group: 'machines', kind: 'cleanup', label: CLEANUP_PART[status].label, status: CLEANUP_PART[status].status, detail: `${entries.length - entries.filter((e) => e.state === 'live').length} of ${entries.length} closed${failed ? `, ${failed} failed` : ''}` },
    ...entries.map((e): BomPart => ({
      id: `resource:${e.kind}:${e.locator}`, group: 'machines', kind: e.kind, label: `${KIND_WORDS[e.kind]} on ${e.machineId}`, status: e.state === 'failed' ? 'failed' : 'recorded',
      at: e.endedAt ?? e.createdAt, detail: `${e.locator}: ${STATE_WORDS[e.state]}${e.reason ? ` (${e.reason})` : ''}`,
    })),
  ];
}
