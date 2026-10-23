// The memory floor (issue #2291, design.md "The memory floor"): a machine takes a new job, or a job back, only while its
// memory available, less what the jobs it started lately have yet to take and what the new job needs, stays at or above
// its floor. Below the floor the decider pauses the job that started there last, on the Park button's path, one at a time.
import type { JobId, LaneId, MachineId } from './types.ts';

/** A machine's own memory floor (its `memoryFloorGiB` and `memoryPerJobGiB` options). Absent fields: the defaults. A floor of 0: off. */
export interface MemoryFloor { floorGiB?: number; perJobGiB?: number }

/** The default floor: this share of the machine's memory, in percent, and at least `MEMORY_FLOOR_MIN_GIB`. */
export const MEMORY_FLOOR_PERCENT = 10;
export const MEMORY_FLOOR_MIN_GIB = 1;
/**
 * Issue #2499: a machine whose memory pressure (PSI `some` avg10) is at or above this share, in percent, takes no new job:
 * its tasks already wait on memory, as a seat near its cgroup limit does while it still reads memory available.
 */
export const MEMORY_PRESSURE_PERCENT = 20;
/**
 * Issue #2499: a machine that saw an OOM kill (a process killed for memory) less than this ago takes no new job: it is at
 * its memory limit, though its reading may show memory available again once the kill freed it.
 */
export const MEMORY_OOM_KILL_MS = 10 * 60_000;
/** The default memory a new job needs, in GiB: room for an agent and a JVM build. */
export const MEMORY_PER_JOB_GIB = 2;
/** A job that started (or resumed) less than this ago has not taken its memory yet: it still reserves a job's memory. */
export const MEMORY_RAMP_MS = 10 * 60_000;
/** After a memory pause on a machine, no other there for this long: the park frees memory, and the next reading shows it. */
export const MEMORY_PAUSE_EVERY_MS = 2 * 60_000;
/**
 * How old a job's own wait is before its agent ends (issue #2326): a wait the hopper answers in a few seconds (a request of
 * the job, issue #998) pays no park and restore, and an agent that ended at once is seen as stranded first (issue #1779).
 */
export const WAIT_RELEASE_AFTER_MS = 5_000;

/** A running job the decider pauses because its machine's memory is below the floor. */
export interface MemoryPausePlan {
  jobId: JobId;
  laneId: LaneId;
  machineId: MachineId;
  /** The memory available the decider read, and the floor, in bytes. */
  availableBytes: number;
  floorBytes: number;
  reason: string;
}

/** Set on a job when a memory pause names it; kept while it is parked and queued again, cleared when it runs again. */
export interface JobMemoryPaused { at: string; machineId: MachineId; availableBytes: number; floorBytes: number }

/** The wait reason of a job no machine's memory holds now (issue #2303 reads it). */
export const MEMORY_WAIT = 'waiting for memory';

/**
 * A job on its own wait whose agent session is still live on its machine, and whose wait the hopper ends by itself
 * (issue #2303): its agent ends, memory short or not (issue #2326). `since`: when its wait began.
 */
export interface WaitSession { jobId: JobId; machineId: MachineId; since: string }

/** A job on its own wait whose agent the decider ends, so no waiting job holds memory (issues #2303, #2326). */
export interface WaitReleasePlan { jobId: JobId; machineId: MachineId; reason: string }

/**
 * Set on a job on its own wait when its agent was ended (issues #2303, #2326); cleared when its session resumes or its wake
 * queues it to resume elsewhere. `checkpointAt`: the checkpoint taken after its agent ended, with its session; with it the
 * job resumes on any machine with room.
 */
export interface JobWaitReleased { at: string; machineId: MachineId; checkpointAt?: string }
