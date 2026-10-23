// A job's machine as the reap, the sweep and the checkpoints reach it (issues #410, #921), beside ports.ts (re-exported
// from it) for its size.
import type { DiscoveryFacts } from './blast-radius.ts';
import type { CheckpointCapture } from './checkpoints.ts';
import type { ContainerStorage, SurveyedCache } from './hopper-disk.ts';
import type { Leftover } from './leftovers.ts';
import type { KeptReason } from './kept-work.ts';
import type { ExitedContainer, Pruned } from './storage-prune.ts';
import type { Trimmed } from './disk-trim.ts';

/**
 * What the reap at a job's end kept: repositories in its scratch dir holding uncommitted or unpushed work. `pushed`
 * (issue #630): those whose HEAD holds a remote branch the default branch does not; absent, none. `removed` (issue #1120):
 * the containers and volumes labelled with the job's id that it removed; absent, none. `left` (issue #1452): the job's dirs
 * it set out to remove and could not; absent, none (or a client older than this). `tips` (issue #2087): for each kept
 * repository with no change, the commits that hold work no remote has; absent, none (or a client older than this). `used`
 * (issue #2498): what the job's scope used, read before the reap stopped it; absent, no scope there (or a client older than this).
 */
export interface Reaped {
  kept: string[]; tips?: Record<string, string[]>;
  /** Why it kept each it kept (issue #2494); none from a client older than that. */
  reasons?: Record<string, KeptReason[]>;
  pushed?: string[]; left?: string[]; removed?: ContainersRemoved; used?: ResourceUse;
}

/**
 * What a job's scope used (issue #2498), as `job.resources_used` records it: its peak memory (cgroup `memory.peak`), its CPU
 * time (`cpu.stat` `usage_usec`) and the OOM kills in it (`memory.events` `oom_kill`), each absent where the cgroup had none.
 */
export type ResourceUse = { memoryPeakBytes?: number; cpuSeconds?: number; oomKills?: number };

/**
 * The containers and volumes a reap removed (issue #1120), as `job.containers_removed` records them; `details` (issue #975):
 * what the reap said of each container before it removed it, for the job's parts list; absent, none (a client older than this).
 */
export type ContainersRemoved = { containers: string[]; volumes: string[]; details?: ContainerDetails[] };
/** One container a reap removed (issue #975): its name, image, and when it started and stopped; a time absent never came. */
export type ContainerDetails = { id: string; name: string; image: string; startedAt?: string; stoppedAt?: string };

/** What a job left on a machine, as the sweep's survey finds it (issue #410): job ids, and each scratch dir with its age. */
export interface Survey {
  /** Jobs with a running scope (`hopper-job-<id>.scope`). */
  scopes: string[];
  /** Jobs with a process carrying their HOPPER_JOB_ID. */
  processes: string[];
  /** Each scratch dir `<work tree>/.worktrees/@scratch/<job id>` under the work trees asked about (job-layout.ts; and the layout before's). */
  scratch: { jobId: string; path: string; ageMs: number }[];
  /** Each job worktree `<work tree>/.worktrees/<name>/<job id>` there (issue #1188; and the layout before's); absent, none. */
  trees?: { path: string; ageMs: number }[];
  /**
   * Each work tree asked about whose `.worktrees` is there (issue #1120): a kept job's scratch dir
   * missing from one of these is gone. Absent (a client older than this), none is known.
   */
  roots?: string[];
  /**
   * The hopper's own disk use there (issue #1120): for each work tree in `roots`, the bytes its `.worktrees` holds, and what the layout
   * before left. Absent or empty: not measured (a client older than this, a machine with no `timeout`, a slow disk).
   */
  usage?: { path: string; bytes: number }[];
  /** Jobs with a container or a volume labelled with their id there (issue #1120); absent (a client older than this), none known. */
  containers?: string[];
  /** Each cache place in the home there (issue #2494); absent or empty: not measured (a client older than this, no `timeout`). */
  caches?: SurveyedCache[];
  /** Each container runtime's storage there by kind (issue #2494); absent or empty: no runtime answered, or not measured. */
  storage?: ContainerStorage[];
  /** Each exited container of each container runtime there (issue #2494), for the storage prune; absent, none (or a client older than this). */
  exited?: ExitedContainer[];
}

/**
 * A machine as the reap and the sweep reach it (issue #410): the fixed scripts run there through its own
 * connection — this machine, ssh, or a client target's `/reap` and `/survey` — never in a pane. Each
 * rejects when the machine cannot be reached or the script did not finish.
 */
export interface MachineShell {
  /**
   * Stops the job's scope and every process carrying its id; removes `scratch` (its own) unless it holds work not
   * pushed, or `keep` (a timed-out job's, issue #630: it may go on there); `discard` removes it whatever it holds (a
   * person discarded its kept work, issue #1010). Says what it kept and what was pushed.
   */
  reap(jobId: string, scratch?: string, keep?: boolean, discard?: boolean): Promise<Reaped>;
  /** What jobs left there: scopes, processes, and the scratch dirs under `roots`. */
  survey(roots: string[]): Promise<Survey>;
  /**
   * Writes `content` to `file` under `dir`, the job's own credentials dir (`…/.worktrees/@scratch/<job id>/credentials`),
   * mode 600, replacing it whole (issue #441): a running job reads its connection's current token there.
   * `make`: the work tree may be made here (the jobs dir); else a work tree that is not there is refused.
   */
  keepCredential(jobId: string, dir: string, file: string, content: string, make?: boolean): Promise<void>;
  /** What the machine holds (issue #542): its tools, its access, its credential sources — names only. */
  discover(): Promise<DiscoveryFacts>;
  /**
   * Whether the machine reaches the hopper at `url` (issue #695), checked there: undefined when it does, or when the
   * check cannot run there (a client older than it); else why not, plainly, naming the URL.
   */
  reach(url: string): Promise<string | undefined>;
  /**
   * A running job's checkpoint (issue #921): its `worktree` (in its own scratch dir) read for the patch from a commit on
   * the remote and the commits not pushed, and its agent `session`'s file, compressed. Never writes there. Absent: the
   * shell takes none.
   */
  checkpoint?(jobId: string, worktree: string, session: string): Promise<CheckpointCapture>;
  /**
   * The leftovers in the `.hopper-scratch` of each work tree in `roots` (issue #1116): each dir in it but its shared
   * dependencies, and its repository mirrors while one of those holds it, with age, size and whether it holds work not
   * pushed. Only reads. Absent: the shell lists none.
   */
  leftovers?(roots: string[]): Promise<Leftover[]>;
  /**
   * Removes the leftover at `path` whatever it holds, a person's decision (issue #1116): `gone` when it was not there,
   * `left` when it is still there. Absent: the shell removes none.
   */
  removeLeftover?(path: string): Promise<'removed' | 'gone' | 'left'>;
  /**
   * The storage prune (issue #2494): removes `containers` (`<runtime>:<id>`, exited ones the hopper chose) while they are still
   * exited and carry no label it keeps, each anonymous volume no container uses, and each image no container uses built more
   * than `days` ago but the hopper's own; never forced. Says what it removed. Absent: the shell prunes nothing.
   */
  prune?(days: number, containers: string[]): Promise<Pruned>;
  /** The trim (issue #2494): fstrim on the filesystem the machine's home is on; says how it ended. Absent: the shell trims nothing. */
  trim?(): Promise<Trimmed>;
}
