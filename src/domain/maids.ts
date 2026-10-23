// The maids (issue #2504 part 14, design.md "The resource ledger"): the cleanup of an ended job, one ledger entry at a
// time. Each entry still `live` or `failed` once the job's own cleanup is over is a **cleanup item**: the maids reap it
// through its machine's own shell, and an entry the reap does not close is tried again after a backoff, kept on the entry
// (its attempts and its next attempt), so a restart goes on where the last pass stopped. Pure: no I/O, no clock.
import { jobScratchOf, OLD_SCRATCH_DIR, worktreeParts } from './job-layout.ts';
import type { LedgerEntry } from './resource-ledger.ts';
import { TERMINAL_STATUSES, type Job } from './types.ts';

/** The wait before a cleanup item's second attempt; it doubles with each attempt after, up to `MAID_RETRY_MAX_MS`. */
export const MAID_RETRY_FIRST_MS = 60_000;
export const MAID_RETRY_MAX_MS = 60 * 60_000;

/** How long after its `attempts`-th attempt failed a cleanup item is tried again. */
export const maidRetryMs = (attempts: number): number => Math.min(MAID_RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1), MAID_RETRY_MAX_MS);

/** The cleanup items of one job on one machine: one reap there tries them all. */
export interface MaidWork { jobId: string; machineId: string; entries: LedgerEntry[] }

/**
 * The cleanup items due at `now` in `open` (every entry `live` or `failed`), by job and machine: each entry of an ended job
 * whose own cleanup is over (no `cleanupDue`, no `cleanupDeferred`: that cleanup judges them first), past its retention
 * (`retainedUntil`) and its next attempt (`nextAttemptAt`). Never a herdr pane: only the job's executor closes one. A job the
 * store does not know is not judged.
 */
export function maidWorkOf(open: readonly LedgerEntry[], jobOf: (id: string) => Pick<Job, 'status' | 'cleanupDue' | 'cleanupDeferred'> | undefined, now: number): MaidWork[] {
  const due = (at: string | undefined): boolean => at === undefined || Date.parse(at) <= now;
  const out = new Map<string, MaidWork>();
  for (const e of open) {
    if ((e.state !== 'live' && e.state !== 'failed') || e.kind === 'herdr_pane' || !due(e.retainedUntil) || !due(e.nextAttemptAt)) continue;
    const job = jobOf(e.jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status) || job.cleanupDue || job.cleanupDeferred) continue;
    const key = `${e.jobId}\0${e.machineId}`;
    (out.get(key) ?? out.set(key, { jobId: e.jobId, machineId: e.machineId, entries: [] }).get(key)!).entries.push(e);
  }
  return [...out.values()];
}

/**
 * The job's scratch dir on machine `machineId`, as its entries there name it — the scratch dir, the container runtime in
 * it, or the work tree of its job worktree —, for the reap; undefined when none names it.
 */
export function maidScratchOf(entries: readonly LedgerEntry[], jobId: string, machineId: string): string | undefined {
  const here = entries.filter((e) => e.jobId === jobId && e.machineId === machineId);
  const dir = here.find((e) => e.kind === 'scratch_dir')?.locator;
  if (dir) return dir;
  const runtime = here.find((e) => e.kind === 'container_runtime')?.locator;
  if (runtime) return runtime.slice(0, runtime.lastIndexOf('/'));
  for (const e of here) {
    const tree = e.kind === 'job_worktree' ? worktreeParts(e.locator) : undefined;
    if (tree) return tree.old ? `${tree.workTree}/${OLD_SCRATCH_DIR}/${jobId}` : jobScratchOf(tree.workTree, jobId);
  }
  return undefined;
}
