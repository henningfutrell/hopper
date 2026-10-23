// A job's resource ledger (issue #2504, design.md "The resource ledger"): each thing the hopper made for a job on a machine —
// its scratch dir, its job worktree, its job scope, its own container runtime, its processes and its labelled containers —, recorded once the job's executor says it made it, and closed by the
// job's cleanup or by the sweep as each reap says: reaped, kept (work not pushed), or failed with why. A job's **cleanup
// status** is read from its entries and its cleanup record. Pure: no I/O, no clock — `at` is passed in.
import type { BomPart, BomStatus } from './job-bom.ts';
import { jobScratchOf, scratchParts, worktreeJobOf, worktreeParts } from './job-layout.ts';
import type { SweepSettings } from './machines.ts';
import { sweepReapAtOf } from './retention.ts';
import type { Reaped, Survey } from './machine-shell.ts';
import { TERMINAL_STATUSES, type Job } from './types.ts';

/** What a ledger entry is. */
export const LEDGER_KINDS = ['scratch_dir', 'job_worktree', 'job_scope', 'container_runtime', 'job_processes', 'job_containers'] as const;
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
  /** Until when the reap at the job's end kept it for a retention (issue #2504 part 5): no cleanup leftover before then. */
  retainedUntil?: string;
}

/** A ledger entry before the store has it; `retainedUntil` only for one the reconciler records (part 6). */
export type NewLedgerEntry = Pick<LedgerEntry, 'jobId' | 'machineId' | 'kind' | 'locator' | 'createdAt' | 'retainedUntil'>;

export interface ResourceLedgerRepository {
  /** Records an entry as `live`, with its `retainedUntil` if any; one already there (same job, kind and locator) is left as it is. */
  record(entry: NewLedgerEntry): void;
  /** Closes the job's entry of that kind and locator, unless it is `reaped`: a `kept` or `failed` one a later reap may close. */
  close(jobId: string, kind: LedgerKind, locator: string, state: Exclude<LedgerState, 'live'>, at: string, reason?: string): void;
  /** Marks the job's entry, while `live` or `failed`, kept for a retention until `until`. */
  retain(jobId: string, kind: LedgerKind, locator: string, until: string): void;
  /** The job's entries, oldest first. */
  forJob(jobId: string): LedgerEntry[];
  /** Every entry still `live` or `failed`, of every job, by job then oldest first: what the leftover check reads. */
  open(): LedgerEntry[];
  /** Every entry on the machine, open or closed: what the reconciler reads (part 6). */
  onMachine(machineId: string): LedgerEntry[];
}

/**
 * A job's cleanup status: no entry; the job not ended, so what it has is in use; its cleanup owed (not reached, or an entry
 * still live); under way; done; done with work kept; kept for a retention (every live entry); or a removal failed.
 */
export const CLEANUP_STATUSES = ['none', 'in_use', 'pending', 'in_progress', 'done', 'kept_work', 'retained', 'failed'] as const;
export type CleanupStatus = typeof CLEANUP_STATUSES[number];

/**
 * The entries an executor's saved state names (`cwd`, `jobWorktree`, `scope`, `containerRuntime`: the job's own container
 * runtime's dir in its scratch dir, issue #1295, with its containers, volumes and storage), on machine `machineId`.
 */
export function ledgerEntriesOf(jobId: string, machineId: string, state: unknown, at: string): NewLedgerEntry[] {
  const s = (state ?? {}) as { cwd?: unknown; jobWorktree?: unknown; scope?: unknown; containerRuntime?: unknown };
  const path = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/');
  const out: NewLedgerEntry[] = [];
  const add = (kind: LedgerKind, locator: string): void => { out.push({ jobId, machineId, kind, locator, createdAt: at }); };
  if (path(s.cwd)) add('scratch_dir', jobScratchOf(s.cwd, jobId));
  if (path(s.jobWorktree)) add('job_worktree', s.jobWorktree);
  if (typeof s.scope === 'string' && s.scope) add('job_scope', s.scope);
  if (path(s.containerRuntime)) add('container_runtime', s.containerRuntime);
  return out;
}

/** The locator of a job's processes (issue #2504 part 9): the variable the reap and the survey find them by. */
export const processesLocatorOf = (jobId: string): string => `HOPPER_JOB_ID=${jobId}`;
/** The locator of a job's containers and volumes (part 9): the label they carry, `JOB_LABEL` in src/client/job-runtime.ts. */
export const containersLocatorOf = (jobId: string): string => `hopper.job=${jobId}`;
/** The kinds a reap always stops, whatever it does with the scratch dir: the scope and the processes. */
const stopped = (kind: LedgerKind): boolean => kind === 'job_scope' || kind === 'job_processes';

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * What a reap says of each live or kept entry: a dir it could not remove failed; with work kept, the scratch dir and the job
 * worktree are kept (the reap keeps them together), but not the container runtime and the containers, which the reap
 * removes all the same; else each is reaped. A scope and the processes are always stopped. A reap that did not look
 * at the scratch dir (`scratch` false) judges those only: the containers wait for the survey (part 9). A reaped entry is not judged again; a failed one a later reap
 * removed is reaped.
 */
export function reapClosures(entries: readonly LedgerEntry[], said: Reaped, scratch = true): { entry: LedgerEntry; state: Exclude<LedgerState, 'live'>; reason?: string }[] {
  return entries.filter((e) => e.state !== 'reaped' && (scratch || stopped(e.kind))).map((entry) => {
    if (stopped(entry.kind)) return { entry, state: 'reaped' as const };
    const left = said.left?.find((p) => within(p, entry.locator) || within(entry.locator, p));
    if (left) return { entry, state: 'failed' as const, reason: `${left} is still there` };
    return { entry, state: said.kept.length > 0 && (entry.kind === 'scratch_dir' || entry.kind === 'job_worktree') ? 'kept' as const : 'reaped' as const };
  }).filter((c) => c.state !== c.entry.state || c.reason !== c.entry.reason);
}

/**
 * The entries a reap that kept the scratch dir for a retention (issue #2504 part 5) leaves open: each `live` or `failed` one
 * but the scope and the processes, which the reap stops all the same. The sweep judges them once the retention is over.
 */
export function retainedEntriesOf(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => !stopped(e.kind) && (e.state === 'live' || e.state === 'failed'));
}

/** How long after a job ended an entry may stay `live` or `failed` before it is a **cleanup leftover** (issue #2504). */
export const CLEANUP_GRACE_MINUTES = 60;

/** An ended job's cleanup leftovers: its entries still `live` or `failed` once the grace period after its end passed. */
export interface CleanupLeftover { jobId: string; endedAt: string; entries: LedgerEntry[] }

/**
 * The cleanup leftovers in `open` (every entry still `live` or `failed`), by job: of a job that ended, each entry
 * `CLEANUP_GRACE_MINUTES` past the job's end — when it finished, else when it last changed —, or past its retention
 * (`retainedUntil`, part 5) when that ends later. A job the store does not know is not judged here.
 */
export function cleanupLeftoversOf(open: readonly LedgerEntry[], jobOf: (id: string) => Pick<Job, 'status' | 'finishedAt' | 'updatedAt'> | undefined, now: number): CleanupLeftover[] {
  const byJob = new Map<string, LedgerEntry[]>();
  for (const e of open) if (e.state === 'live' || e.state === 'failed') (byJob.get(e.jobId) ?? byJob.set(e.jobId, []).get(e.jobId)!).push(e);
  const out: CleanupLeftover[] = [];
  for (const [jobId, entries] of byJob) {
    const job = jobOf(jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status)) continue;
    const endedAt = job.finishedAt ?? job.updatedAt;
    const over = entries.filter((e) => now - Math.max(Date.parse(endedAt), e.retainedUntil ? Date.parse(e.retainedUntil) : 0) >= CLEANUP_GRACE_MINUTES * 60_000);
    if (over.length > 0) out.push({ jobId, endedAt, entries: over });
  }
  return out;
}

/** Why an entry the survey no longer found is closed `reaped` (issue #2504 part 3): removed outside the hopper, or by a reap no one recorded. */
export const GONE_REASON = 'not found on the machine';

/**
 * The reconciler's closures on machine `machineId` (issue #2504 parts 3, 8): each entry not yet `reaped` there (`live`,
 * `failed` or `kept`) of an ended job whose thing the machine's survey no longer found, closed `reaped` with `GONE_REASON`. A scratch dir only in a
 * work tree the survey looked in (`found.roots`), and a container runtime with its scratch dir; a job worktree only when the
 * survey also lists job worktrees; a scope that no longer runs; processes the survey no longer finds; containers when the survey
 * lists containers and names none of the job's (part 9). A job that has not ended, and a job the store does not know, is not judged.
 */
export function goneClosures(entries: readonly LedgerEntry[], found: Survey, machineId: string, jobOf: (id: string) => Pick<Job, 'status'> | undefined): { entry: LedgerEntry; state: 'reaped'; reason: string }[] {
  const roots = new Set(found.roots ?? []);
  const dirs = new Set(found.scratch.map((d) => d.path)), trees = found.trees && new Set(found.trees.map((t) => t.path));
  const scratchGone = (dir: string): boolean => roots.has(scratchParts(dir)?.workTree ?? '') && !dirs.has(dir);
  const gone = (e: LedgerEntry): boolean => {
    if (e.kind === 'job_scope') return !found.scopes.includes(e.jobId);
    if (e.kind === 'job_processes') return !found.processes.includes(e.jobId);
    if (e.kind === 'job_containers') return found.containers !== undefined && !found.containers.includes(e.jobId);
    if (e.kind === 'scratch_dir') return scratchGone(e.locator);
    if (e.kind === 'container_runtime') return scratchGone(e.locator.slice(0, e.locator.lastIndexOf('/')));
    return trees !== undefined && roots.has(worktreeParts(e.locator)?.workTree ?? '') && !trees.has(e.locator);
  };
  return entries.filter((e) => e.machineId === machineId && e.state !== 'reaped' && gone(e)).filter((e) => {
    const job = jobOf(e.jobId);
    return job !== undefined && TERMINAL_STATUSES.includes(job.status);
  }).map((entry) => ({ entry, state: 'reaped' as const, reason: GONE_REASON }));
}

/** An entry's key in a set: its job, kind and locator. */
export const ledgerKey = (jobId: string, kind: LedgerKind, locator: string): string => `${jobId}\0${kind}\0${locator}`;

/**
 * The reconciler's records on machine `machineId` (issue #2504 part 6): what the survey found there of an ended job the store
 * knows that no entry (`ledgered`: their `ledgerKey`s) names — a job outside the job list, or what was left before the ledger.
 * Each scratch dir and job worktree, kept until the sweep's reap of it (`sweepReapAtOf`), so it is no cleanup leftover
 * before; each scope that still runs; each job's processes and labelled containers there (part 9). A job that has not ended, and one the store does not know (another hopper's, a test's),
 * is not recorded. `at` is `nowMs`.
 */
export function unledgeredEntriesOf(found: Survey, ledgered: ReadonlySet<string>, jobOf: (id: string) => Pick<Job, 'id' | 'status' | 'finishedAt'> | undefined, machineId: string, s: SweepSettings | undefined, nowMs: number): NewLedgerEntry[] {
  const createdAt = new Date(nowMs).toISOString(), out: NewLedgerEntry[] = [];
  const ended = (job: Pick<Job, 'status'> | undefined): boolean => job !== undefined && TERMINAL_STATUSES.includes(job.status);
  const add = (jobId: string, kind: LedgerKind, locator: string, retainedUntil?: string): void => {
    if (ledgered.has(ledgerKey(jobId, kind, locator)) || out.some((e) => e.jobId === jobId && e.kind === kind && e.locator === locator)) return;
    out.push({ jobId, machineId, kind, locator, createdAt, ...(retainedUntil ? { retainedUntil } : {}) });
  };
  for (const dir of found.scratch) {
    const job = jobOf(dir.jobId);
    if (job && ended(job)) add(job.id, 'scratch_dir', dir.path, sweepReapAtOf(s, job, dir.ageMs, nowMs));
  }
  for (const tree of found.trees ?? []) {
    const job = worktreeJobOf(tree.path, jobOf);
    if (job && ended(job)) add(job.id, 'job_worktree', tree.path, sweepReapAtOf(s, job, tree.ageMs, nowMs));
  }
  for (const id of found.scopes) if (ended(jobOf(id))) add(id, 'job_scope', `hopper-job-${id}.scope`);
  for (const id of found.processes) if (ended(jobOf(id))) add(id, 'job_processes', processesLocatorOf(id));
  for (const id of found.containers ?? []) if (ended(jobOf(id))) add(id, 'job_containers', containersLocatorOf(id));
  return out;
}

/**
 * The work trees the entries not yet `reaped` (`live`, `failed` or `kept`) on machine `machineId` are in (issue #2504 parts 7,
 * 8), sorted: the sweep surveys them beside the work trees the job list names, so a thing that only an older job left — kept
 * work too — is found, reaped, or closed gone. A scope, the processes and the containers have no work tree.
 */
export function ledgerRootsOf(entries: readonly LedgerEntry[], machineId: string): string[] {
  const rootOf = (e: LedgerEntry): string | undefined => (e.kind === 'scratch_dir' ? scratchParts(e.locator)?.workTree
    : e.kind === 'container_runtime' ? scratchParts(e.locator.slice(0, e.locator.lastIndexOf('/')))?.workTree
      : e.kind === 'job_worktree' ? worktreeParts(e.locator)?.workTree : undefined);
  const roots = entries.filter((e) => e.machineId === machineId && e.state !== 'reaped').map(rootOf);
  return [...new Set(roots.filter((r): r is string => r !== undefined))].sort();
}

/** The cleanup leftovers on one machine, as Machines shows them (issue #2504 part 3): jobs, entries, and how many of those failed. */
export interface MachineCleanupLeftovers { jobs: number; entries: number; failed: number }

/** The leftovers' counts on machine `machineId`; undefined when none is there. */
export function machineLeftoversOf(leftovers: readonly CleanupLeftover[], machineId: string): MachineCleanupLeftovers | undefined {
  const here = leftovers.map((l) => l.entries.filter((e) => e.machineId === machineId)).filter((es) => es.length > 0);
  if (here.length === 0) return undefined;
  const entries = here.flat();
  return { jobs: here.length, entries: entries.length, failed: entries.filter((e) => e.state === 'failed').length };
}

/** The job's cleanup status, from its entries and its cleanup record (`cleanupDue`, `cleanupDeferred`). */
export function cleanupStatusOf(job: Pick<Job, 'status' | 'cleanupDue' | 'cleanupDeferred'>, entries: readonly LedgerEntry[]): CleanupStatus {
  if (entries.length === 0) return 'none';
  if (!TERMINAL_STATUSES.includes(job.status)) return 'in_use';
  if (job.cleanupDeferred) return 'pending';
  if (job.cleanupDue) return 'in_progress';
  if (entries.some((e) => e.state === 'failed')) return 'failed';
  const live = entries.filter((e) => e.state === 'live');
  if (live.length > 0) return live.every((e) => e.retainedUntil) ? 'retained' : 'pending';
  return entries.some((e) => e.state === 'kept') ? 'kept_work' : 'done';
}

const KIND_WORDS: Record<LedgerKind, string> = { scratch_dir: 'Scratch dir', job_worktree: 'Job worktree', job_scope: 'Job scope', container_runtime: 'Container runtime', job_processes: 'Job processes', job_containers: 'Job containers' };
const STATE_WORDS: Record<LedgerState, string> = { live: 'still there', reaped: 'removed', kept: 'kept: it holds work not pushed', failed: 'not removed' };
const CLEANUP_PART: Record<Exclude<CleanupStatus, 'none'>, { status: BomStatus; label: string }> = {
  in_use: { status: 'running', label: 'Cleanup: the job still uses what it has' },
  pending: { status: 'open', label: 'Cleanup: owed' },
  in_progress: { status: 'running', label: 'Cleanup: under way' },
  done: { status: 'done', label: 'Cleanup: done' },
  kept_work: { status: 'open', label: 'Cleanup: done, work not pushed kept' },
  retained: { status: 'open', label: 'Cleanup: work kept for its retention' },
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
      at: e.endedAt ?? e.createdAt, detail: `${e.locator}: ${STATE_WORDS[e.state]}${e.state === 'live' && e.retainedUntil ? `, kept until ${e.retainedUntil}` : ''}${e.reason ? ` (${e.reason})` : ''}`,
    })),
  ];
}
