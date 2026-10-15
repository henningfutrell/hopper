// Work not pushed (issue #1010, design.md "Work not pushed"): an ended job whose scratch dir the reap or the sweep kept,
// because a repository in it holds uncommitted or unpushed work (`job.work_kept`, issue #401). It stays kept until the
// work is pushed (`job.work_removed`, by the sweep) or a person discards it (`job.work_removed` with `discarded`). The
// Failures view lists each with its ways out: Push it (the failed, finished or cancelled job goes on in its own session and
// work tree, told to push) and Discard. Pure. Re-exported from types.ts.
import type { DomainEvent, Job, JobStatus } from './types.ts';
import type { Allowed } from './failures.ts';
import { jobScratchOf, scratchParts, worktreeParts } from './job-layout.ts';

/** The ends whose kept work Push it takes: the job goes on in its own session and work tree. Not a rejected job: it never ran. */
export const PUSHABLE_ENDS: readonly JobStatus[] = ['failed', 'finished', 'cancelled'];

/** The work trail: the events that keep and remove an ended job's scratch dir. */
export const WORK_EVENTS = ['job.work_kept', 'job.work_removed'] as const;

/**
 * Why the sweep discarded kept work with no person (issue #1187): its item is done (`merged`, issue #1105); a newer job of
 * its item finished, its cleanup done, with nothing kept (`superseded`); or it finished a proposal or a research report, never work to push
 * (`proposal`, `research`).
 */
export const WORK_DISCARD_REASONS = ['merged', 'superseded', 'proposal', 'research'] as const;
export type WorkDiscardReason = typeof WORK_DISCARD_REASONS[number];

/**
 * Pure: why nobody waits on an ended job's kept work any more, or undefined. `itemDone`: its item is done, as the ledger
 * has it. `newest`: the newest job of its item. `kept`: the jobs whose work is kept.
 */
export function discardReasonOf(job: Job, itemDone: boolean, newest: Job | undefined, kept: ReadonlySet<string>): WorkDiscardReason | undefined {
  if (itemDone) return 'merged';
  if (newest && newest.id !== job.id && newest.status === 'finished' && !newest.cleanupDeferred && !kept.has(newest.id)) return 'superseded';
  if (job.status === 'finished' && job.spec.proposal) return 'proposal';
  if (job.status === 'finished' && job.spec.research) return 'research';
  return undefined;
}

/** One ended job's kept work: the repositories holding it, and when it was kept. */
export interface KeptWork { jobId: string; paths: string[]; at: string }

/** Kept work as the Failures view shows it: its job, its machine, and whether each way out is taken now and why not. */
export interface KeptWorkView extends KeptWork {
  status: JobStatus;
  title?: string;
  url?: string;
  /** The machine its scratch dir is on. */
  machineId?: string;
  /** Its open hand-off: Push it resolves it as Continue. */
  handoffId?: string;
  actions: { push: Allowed; discard: Allowed };
}

/** The jobs whose newest work event kept their work, newest first. `newestFirst`: the work trail as the event log answers it. */
export function keptWorkOf(newestFirst: readonly DomainEvent[]): KeptWork[] {
  const seen = new Set<string>();
  const out: KeptWork[] = [];
  for (const e of newestFirst) {
    if (!e.jobId || seen.has(e.jobId) || !(WORK_EVENTS as readonly string[]).includes(e.type)) continue;
    seen.add(e.jobId);
    if (e.type === 'job.work_kept') out.push({ jobId: e.jobId, paths: [...(e.data as { paths: string[] }).paths], at: e.at });
  }
  return out;
}

/**
 * The job's own scratch dir (`…/.worktrees/@scratch/<job id>`, job-layout.ts) its kept repositories are in, or beside: a
 * job worktree `<work tree>/.worktrees/<name>/<job id>` (issue #1188) has it in that work tree. A path of the layout before
 * answers that layout's scratch dir, which the reap takes all the same. Undefined when none is.
 */
export function scratchOf(paths: readonly string[], jobId: string): string | undefined {
  for (const p of paths) {
    for (let at = p.length; at > 0; at = p.lastIndexOf('/', at - 1)) {
      const parts = scratchParts(p.slice(0, at));
      if (parts?.jobId === jobId) return p.slice(0, at);
    }
    const tree = worktreeParts(p);
    if (tree && (tree.old ? tree.name.endsWith(`-${jobId}`) : tree.name === jobId)) return jobScratchOf(tree.workTree, jobId);
  }
  return undefined;
}

/** Its scratch dir: by its kept repositories, else by its work tree. */
export function keptScratchOf(kept: KeptWork, job: Job): string | undefined {
  const cwd = (job.executorState as { cwd?: unknown } | undefined)?.cwd;
  return scratchOf(kept.paths, job.id) ?? (typeof cwd === 'string' && cwd.startsWith('/') ? jobScratchOf(cwd, job.id) : undefined);
}

/** The machine a job ran on: its pane's lane's, else where it resumes or is pinned (issue #551). */
export function machineRanOn(job: Job): string | undefined {
  const lane = typeof job.executorState?.laneId === 'string' ? job.executorState.laneId : job.laneId;
  const at = lane?.lastIndexOf('/lane-') ?? -1;
  return lane && at > 0 ? lane.slice(0, at) : job.resumeOn ?? job.spec.machineId;
}
