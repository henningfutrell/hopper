// Job checkpoints (issue #921, design.md "Checkpoints and resume elsewhere"): while a job runs, the hopper copies its
// agent session and a patch of its work that is not pushed from its machine, so the job can resume on another machine
// when its own is lost. Types only.
import type { MachineId } from './types.ts';

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

/** At most this many commits are named on a checkpoint. */
export const CHECKPOINT_COMMITS = 50;

/** What a machine's checkpoint script gave: the checkpoint, compressed (gzip), or why it took none. */
export type CheckpointCapture =
  | { taken: Omit<JobCheckpoint, 'at' | 'machineId' | 'bytes' | 'session'> & { patch: Buffer; session?: Buffer } }
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
