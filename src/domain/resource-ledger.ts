// A job's resource ledger (issue #2504, design.md "The resource ledger"): each thing the hopper made for a job on a machine —
// its scratch dir, its job worktree, its job scope, its own container runtime, its processes and its labelled containers, its agent's session, its herdr pane —, recorded once the job's executor says it made it, and closed by the
// job's cleanup or by the sweep as each reap says: reaped, kept (work not pushed), or failed with why. A job's **cleanup
// status** is read from its entries and its cleanup record. Pure: no I/O, no clock — `at` is passed in.
import type { BomPart, BomStatus } from './job-bom.ts';
import type { JobDiskUse } from './hopper-disk.ts';
import { jobScratchOf, scratchParts, worktreeJobOf, worktreeParts } from './job-layout.ts';
import type { SweepSettings } from './machines.ts';
import { sweepReapAtOf } from './retention.ts';
import type { Reaped, Survey } from './machine-shell.ts';
import { TERMINAL_STATUSES, type Job } from './types.ts';

/** What a ledger entry is. */
export const LEDGER_KINDS = ['scratch_dir', 'job_worktree', 'job_scope', 'container_runtime', 'job_processes', 'job_containers', 'agent_session', 'herdr_pane'] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];

/**
 * Where a ledger entry stands: still there, removed, kept for work not pushed, a removal that failed, or left on a retired
 * machine (issue #2504 part 12), which no reap reaches.
 */
export const LEDGER_STATES = ['live', 'reaped', 'kept', 'failed', 'retired'] as const;
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
  /** How many times the maids tried to reap it (issue #2504 part 14); absent, never. */
  attempts?: number;
  /** When the maids try it again (part 14), after a backoff; absent, at their next pass. */
  nextAttemptAt?: string;
}

/** A ledger entry before the store has it; `retainedUntil` only for one the reconciler records (part 6). */
export type NewLedgerEntry = Pick<LedgerEntry, 'jobId' | 'machineId' | 'kind' | 'locator' | 'createdAt' | 'retainedUntil'>;

export interface ResourceLedgerRepository {
  /** Records an entry as `live`, with its `retainedUntil` if any; one already there (same job, kind and locator) is left as it is. */
  record(entry: NewLedgerEntry): void;
  /** Closes the job's entry of that kind and locator, unless it is `reaped`: a `kept` or `failed` one a later reap may close. */
  close(jobId: string, kind: LedgerKind, locator: string, state: Exclude<LedgerState, 'live'>, at: string, reason?: string): void;
  /**
   * The maids' attempt on the job's entry (part 14), while `live` or `failed`, that did not close it: `failed` with `reason`,
   * one attempt more, tried again at `next`.
   */
  tried(jobId: string, kind: LedgerKind, locator: string, at: string, reason: string, next: string): void;
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
 * still live); under way; done; done with work kept; kept for a retention (every live entry); left on a retired machine
 * (part 12); or a removal failed.
 */
export const CLEANUP_STATUSES = ['none', 'in_use', 'pending', 'in_progress', 'done', 'kept_work', 'retained', 'machine_retired', 'failed'] as const;
export type CleanupStatus = typeof CLEANUP_STATUSES[number];

/**
 * The entries an executor's saved state names (`cwd`, `jobWorktree`, `scope`, `containerRuntime`: the job's own container
 * runtime's dir in its scratch dir, issue #1295, with its containers, volumes and storage; `paneId`: its herdr pane, issue
 * #2504 part 13), on machine `machineId`.
 */
export function ledgerEntriesOf(jobId: string, machineId: string, state: unknown, at: string): NewLedgerEntry[] {
  const s = (state ?? {}) as { cwd?: unknown; jobWorktree?: unknown; scope?: unknown; containerRuntime?: unknown; paneId?: unknown };
  const path = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/');
  const out: NewLedgerEntry[] = [];
  const add = (kind: LedgerKind, locator: string): void => { out.push({ jobId, machineId, kind, locator, createdAt: at }); };
  if (path(s.cwd)) add('scratch_dir', jobScratchOf(s.cwd, jobId));
  if (path(s.jobWorktree)) add('job_worktree', s.jobWorktree);
  if (typeof s.scope === 'string' && s.scope) add('job_scope', s.scope);
  if (path(s.containerRuntime)) add('container_runtime', s.containerRuntime);
  if (typeof s.paneId === 'string' && s.paneId) add('herdr_pane', s.paneId);
  return out;
}

/** The locator of a job's processes (issue #2504 part 9): the variable the reap and the survey find them by. */
export const processesLocatorOf = (jobId: string): string => `HOPPER_JOB_ID=${jobId}`;
/** The locator of a job's containers and volumes (part 9): the label they carry, `JOB_LABEL` in src/client/job-runtime.ts. */
export const containersLocatorOf = (jobId: string): string => `hopper.job=${jobId}`;
/**
 * The entry of the agent session the job's agent runs in (issue #2504 part 11), as the executor reports it once the agent is
 * up (`agentSession`, issue #501), on machine `machineId`: its locator is the session id.
 */
export const agentSessionEntryOf = (jobId: string, machineId: string, session: string, at: string): NewLedgerEntry =>
  ({ jobId, machineId, kind: 'agent_session', locator: session, createdAt: at });
/** The kinds a reap always stops, whatever it does with the scratch dir: the scope, the processes and the agent (part 11) among them. */
const stopped = (kind: LedgerKind): boolean => kind === 'job_scope' || kind === 'job_processes' || kind === 'agent_session';

/**
 * Why a herdr pane entry (issue #2504 part 13) failed: the cleanup reaped through the machine (issue #2490), not through the
 * job's executor, which alone closes its pane.
 */
export const PANE_NOT_REACHED = 'the cleanup did not reach its herdr, so the pane may still be open';
/** Why a herdr pane entry was closed when a person marked the job's deferred cleanup done: they closed it by hand. */
export const PANE_CLOSED_BY_HAND = 'a person marked the cleanup done: closed by hand';

/**
 * The closures of the job's herdr pane entries (part 13) not yet `reaped`: `closed` by the cleanup through the job's executor
 * — it closed the pane, and each pane the job had before was closed when the job left it —, `not_reached` when the cleanup
 * reaped only through the machine, or closed `by_hand` as a person said. No reap closes one: the sweep closes no pane.
 */
export function paneClosures(entries: readonly LedgerEntry[], how: 'closed' | 'not_reached' | 'by_hand'): { entry: LedgerEntry; state: 'reaped' | 'failed'; reason?: string }[] {
  const to = how === 'not_reached' ? { state: 'failed' as const, reason: PANE_NOT_REACHED } : { state: 'reaped' as const, ...(how === 'by_hand' ? { reason: PANE_CLOSED_BY_HAND } : {}) };
  return entries.filter((e) => e.kind === 'herdr_pane' && e.state !== 'reaped' && (e.state !== to.state || e.reason !== to.reason)).map((entry) => ({ entry, ...to }));
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * What a reap says of each live or kept entry: a dir it could not remove failed; with work kept, the scratch dir and the job
 * worktree are kept (the reap keeps them together), but not the container runtime and the containers, which the reap
 * removes all the same; else each is reaped. A scope and the processes are always stopped. A reap that did not look
 * at the scratch dir (`scratch` false) judges those only: the containers wait for the survey (part 9). A reaped entry is not judged again; a failed one a later reap
 * removed is reaped. A herdr pane is not judged: no reap closes it (`paneClosures`).
 */
export function reapClosures(entries: readonly LedgerEntry[], said: Reaped, scratch = true): { entry: LedgerEntry; state: Exclude<LedgerState, 'live'>; reason?: string }[] {
  return entries.filter((e) => e.state !== 'reaped' && e.kind !== 'herdr_pane' && (scratch || stopped(e.kind))).map((entry) => {
    if (stopped(entry.kind)) return { entry, state: 'reaped' as const };
    const left = said.left?.find((p) => within(p, entry.locator) || within(entry.locator, p));
    if (left) return { entry, state: 'failed' as const, reason: `${left} is still there` };
    return { entry, state: said.kept.length > 0 && (entry.kind === 'scratch_dir' || entry.kind === 'job_worktree') ? 'kept' as const : 'reaped' as const };
  }).filter((c) => c.state !== c.entry.state || c.reason !== c.entry.reason);
}

/**
 * The entries a reap that kept the scratch dir for a retention (issue #2504 part 5) leaves open: each `live` or `failed` one
 * but the scope, the processes and the agent session, which the reap stops all the same, and the herdr pane, which the cleanup closes. The sweep judges them once the retention is over.
 */
export function retainedEntriesOf(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => !stopped(e.kind) && e.kind !== 'herdr_pane' && (e.state === 'live' || e.state === 'failed'));
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

/** Why an entry on a retired machine (issue #919) is closed `retired` (issue #2504 part 12). */
export const retiredReasonOf = (machineId: string): string => `its machine ${machineId} is retired: it is no longer configured, so no reap reaches it`;

/**
 * The leftover check's closures (issue #2504 part 12): each entry of `leftovers`, told already, on a retired machine — one
 * that no machine source lists (`listed`) and the plugins config does not name (`configured`) —, closed `retired` with why.
 * So it is no cleanup leftover for good, and stays as the record. None while the plugins config has an error (`configured`
 * undefined). Not final: a reap or the reconciler there, should a machine of that name come back, judges it again.
 */
export function retiredClosures(leftovers: readonly CleanupLeftover[], listed: readonly string[], configured: readonly string[] | undefined): { entry: LedgerEntry; state: 'retired'; reason: string }[] {
  if (configured === undefined) return [];
  const known = new Set([...listed, ...configured]);
  return leftovers.flatMap((l) => l.entries).filter((e) => !known.has(e.machineId)).map((entry) => ({ entry, state: 'retired' as const, reason: retiredReasonOf(entry.machineId) }));
}

/** Why an entry the survey no longer found is closed `reaped` (issue #2504 part 3): removed outside the hopper, or by a reap no one recorded. */
export const GONE_REASON = 'not found on the machine';

/**
 * The reconciler's closures on machine `machineId` (issue #2504 parts 3, 8): each entry not yet `reaped` there (`live`,
 * `failed` or `kept`) of an ended job whose thing the machine's survey no longer found, closed `reaped` with `GONE_REASON`. A scratch dir only in a
 * work tree the survey looked in (`found.roots`), and a container runtime with its scratch dir; a job worktree only when the
 * survey also lists job worktrees; a scope that no longer runs; processes the survey no longer finds; containers when the survey
 * lists containers and names none of the job's (part 9); an agent session once neither a process nor a scope of the job runs (part 11); never a herdr pane, which the survey does not list (part 13). A job that has not ended, and a job the store does not know, is not judged.
 */
export function goneClosures(entries: readonly LedgerEntry[], found: Survey, machineId: string, jobOf: (id: string) => Pick<Job, 'status'> | undefined): { entry: LedgerEntry; state: 'reaped'; reason: string }[] {
  const roots = new Set(found.roots ?? []);
  const dirs = new Set(found.scratch.map((d) => d.path)), trees = found.trees && new Set(found.trees.map((t) => t.path));
  const scratchGone = (dir: string): boolean => roots.has(scratchParts(dir)?.workTree ?? '') && !dirs.has(dir);
  const gone = (e: LedgerEntry): boolean => {
    if (e.kind === 'job_scope') return !found.scopes.includes(e.jobId);
    if (e.kind === 'job_processes') return !found.processes.includes(e.jobId);
    if (e.kind === 'agent_session') return !found.processes.includes(e.jobId) && !found.scopes.includes(e.jobId);
    if (e.kind === 'job_containers') return found.containers !== undefined && !found.containers.includes(e.jobId);
    if (e.kind === 'scratch_dir') return scratchGone(e.locator);
    if (e.kind === 'container_runtime') return scratchGone(e.locator.slice(0, e.locator.lastIndexOf('/')));
    if (e.kind === 'herdr_pane') return false;
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

/**
 * The cleanup leftovers on one machine, as Machines shows them (issue #2504 part 3): jobs, entries, and how many of those failed.
 * `bytes` (part 10): what they hold on disk, as the sweep last measured each job; absent when the measure names none of them.
 * `unmeasured`: how many of the jobs with a leftover on disk the measure does not name (it keeps the biggest jobs only); absent, none.
 */
export interface MachineCleanupLeftovers { jobs: number; entries: number; failed: number; bytes?: number; unmeasured?: number }

/** What a leftover entry holds on disk, as a job's disk measure splits it: its scratch dir (the container runtime is in it) or its worktrees. */
const DISK_PART: Partial<Record<LedgerKind, 'scratchBytes' | 'worktreeBytes'>> = { scratch_dir: 'scratchBytes', container_runtime: 'scratchBytes', job_worktree: 'worktreeBytes' };

/**
 * The leftovers' counts on machine `machineId`; undefined when none is there. With `disks`, the machine's last measure of each
 * job (part 10), each leftover job's scratch dir and worktrees bytes once each, for the parts a leftover entry holds.
 */
export function machineLeftoversOf(leftovers: readonly CleanupLeftover[], machineId: string, disks?: readonly JobDiskUse[]): MachineCleanupLeftovers | undefined {
  const here = leftovers.map((l) => l.entries.filter((e) => e.machineId === machineId)).filter((es) => es.length > 0);
  if (here.length === 0) return undefined;
  const entries = here.flat(), counts = { jobs: here.length, entries: entries.length, failed: entries.filter((e) => e.state === 'failed').length };
  if (!disks) return counts;
  let bytes: number | undefined, unmeasured = 0;
  for (const es of here) {
    const parts = new Set(es.map((e) => DISK_PART[e.kind]).filter((p) => p !== undefined));
    if (parts.size === 0) continue;
    const disk = disks.find((d) => d.jobId === es[0]!.jobId);
    if (!disk) { unmeasured += 1; continue; }
    bytes = (bytes ?? 0) + [...parts].reduce((sum, p) => sum + disk[p], 0);
  }
  return { ...counts, ...(bytes !== undefined ? { bytes } : {}), ...(unmeasured > 0 ? { unmeasured } : {}) };
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
  if (entries.some((e) => e.state === 'retired')) return 'machine_retired';
  return entries.some((e) => e.state === 'kept') ? 'kept_work' : 'done';
}

const KIND_WORDS: Record<LedgerKind, string> = { scratch_dir: 'Scratch dir', job_worktree: 'Job worktree', job_scope: 'Job scope', container_runtime: 'Container runtime', job_processes: 'Job processes', job_containers: 'Job containers', agent_session: 'Agent session', herdr_pane: 'Herdr pane' };
const STATE_WORDS: Record<LedgerState, string> = { live: 'still there', reaped: 'removed', kept: 'kept: it holds work not pushed', failed: 'not removed', retired: 'not removed: its machine is retired' };
const CLEANUP_PART: Record<Exclude<CleanupStatus, 'none'>, { status: BomStatus; label: string }> = {
  in_use: { status: 'running', label: 'Cleanup: the job still uses what it has' },
  pending: { status: 'open', label: 'Cleanup: owed' },
  in_progress: { status: 'running', label: 'Cleanup: under way' },
  done: { status: 'done', label: 'Cleanup: done' },
  kept_work: { status: 'open', label: 'Cleanup: done, work not pushed kept' },
  retained: { status: 'open', label: 'Cleanup: work kept for its retention' },
  machine_retired: { status: 'open', label: 'Cleanup: its machine is retired, so what it holds there was not removed' },
  failed: { status: 'failed', label: 'Cleanup: failed' },
};

/** The maids' attempts on an entry (part 14), for its part: how many, and when the next is while it is still open. */
const maidAttemptsOf = (e: LedgerEntry): string => (!e.attempts ? '' : `; the maids tried it ${e.attempts} time${e.attempts === 1 ? '' : 's'}${
  (e.state === 'live' || e.state === 'failed') && e.nextAttemptAt ? `, next at ${e.nextAttemptAt}` : ''}`);

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
      at: e.endedAt ?? e.createdAt, detail: `${e.locator}: ${STATE_WORDS[e.state]}${e.state === 'live' && e.retainedUntil ? `, kept until ${e.retainedUntil}` : ''}${e.reason ? ` (${e.reason})` : ''}${maidAttemptsOf(e)}`,
    })),
  ];
}
