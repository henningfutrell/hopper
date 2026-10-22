// Job checkpoints (issue #921, design.md "Checkpoints and resume elsewhere"): while a job runs, the hopper copies its
// agent session and a patch of its work that is not pushed from its machine, so the job can resume on another machine
// when its own is lost. Types only.
import type { Job, MachineId } from './types.ts';

/**
 * What a job's latest checkpoint holds, kept on the job: where and when it was taken, the commit its patch applies to,
 * and the commits not pushed then, which the patch carries as uncommitted changes. The patch and the session are in
 * the store's checkpoints, never on the job.
 */
export interface JobCheckpoint {
  at: string;
  machineId: MachineId;
  /** The job's branch then; absent when its worktree was not on a branch. */
  branch?: string;
  /** The commit the patch applies to: one on the remote (the pushed branch, else where it left the default branch). */
  base: string;
  /** The job's HEAD then. */
  head: string;
  /** The commits after `base` then, newest first, `<short sha> <subject>`; at most CHECKPOINT_COMMITS. */
  commits: string[];
  /** The checkpoint's size: its patch and its session, compressed. */
  bytes: number;
  /** Whether it holds the agent session; without it, the job cannot resume elsewhere. */
  session: boolean;
}

/** A parked job picked up to resume elsewhere (issue #921): when, from which checkpoint, the machine it left. */
/**
 * `lost` (issue #1569): it moved off `from` because that machine was lost (the lost-machine move). It is not placed back
 * on `from` until the agent it left there is ended; then the mark goes.
 */
export interface ParkedElsewhere { at: string; checkpointAt: string; from?: MachineId; lost?: true }

/** The moves that park a job to take it off a machine with no person (issue #1892): the signed-out, busy-machine and lost-machine moves. */
export const JOB_MOVES = ['signed_out', 'busy_machine', 'lost_machine'] as const;
export type JobMove = (typeof JOB_MOVES)[number];

/**
 * A park to move the job (issue #1892), kept on it until its pick up: the move, how it goes on (from its checkpoint, or
 * as a new start), whether it had a live pane to end, and whether that end was confirmed. A stop between the park and the
 * pick up leaves it: the move's next pass finishes it (`move-finish.ts`).
 */
export interface ParkedMove { kind: JobMove; how: 'checkpoint' | 'fresh'; live: boolean; ended?: true }

/**
 * Whether the run of `job`, which resumes, reopens its agent session in a new pane (issues #501, #551, #2303): it was
 * parked, continued from its hand-off, or its agent was ended on its own wait. That pane gets its way to the hopper afresh.
 */
export const reopensPane = (job: Job): boolean => job.parked !== undefined || job.continued !== undefined || job.waitReleased !== undefined;

/** At most this many commits are named on a checkpoint. */
export const CHECKPOINT_COMMITS = 50;

/**
 * What a machine's checkpoint script gave: the checkpoint, compressed (gzip), or why it took none. `subagents`: the
 * session's subagent logs (issue #2302), counted in the token ledger only, never kept.
 */
export type CheckpointCapture =
  | { taken: Omit<JobCheckpoint, 'at' | 'machineId' | 'bytes' | 'session'> & { patch: Buffer; session?: Buffer; subagents?: Buffer } }
  | { none: string };

/** The parts of a checkpoint a job reads back when it resumes elsewhere. */
export const CHECKPOINT_PARTS = ['patch', 'session'] as const;
export type CheckpointPart = (typeof CHECKPOINT_PARTS)[number];

/** A stored checkpoint's parts, gzip, scrubbed. */
export interface StoredCheckpoint { jobId: string; at: string; patch: Buffer; session?: Buffer }

export interface CheckpointRepository {
  /** Replaces the job's checkpoint: only the latest is kept. */
  put(c: StoredCheckpoint): void;
  get(jobId: string): StoredCheckpoint | undefined;
  remove(jobId: string): void;
  /** The ids of the jobs with a checkpoint. */
  jobIds(): string[];
}
