// A job's machine as the reap, the sweep and the checkpoints reach it (issues #410, #921), beside ports.ts (re-exported
// from it) for its size.
import type { DiscoveryFacts } from './blast-radius.ts';
import type { CheckpointCapture } from './checkpoints.ts';

/**
 * What the reap at a job's end kept: repositories in its scratch dir holding uncommitted or unpushed work. `pushed`
 * (issue #630): those whose HEAD holds a remote branch the default branch does not; absent, none. `removed` (issue #1120):
 * the containers and volumes labelled with the job's id that it removed; absent, none.
 */
export interface Reaped { kept: string[]; pushed?: string[]; removed?: { containers: string[]; volumes: string[] } }

/** What a job left on a machine, as the sweep's survey finds it (issue #410): job ids, and each scratch dir with its age. */
export interface Survey {
  /** Jobs with a running scope (`hopper-job-<id>.scope`). */
  scopes: string[];
  /** Jobs with a process carrying their HOPPER_JOB_ID. */
  processes: string[];
  /** Each `<work tree>/.hopper-scratch/<job id>` under the work trees asked about. */
  scratch: { jobId: string; path: string; ageMs: number }[];
  /** Each job worktree `<work tree>/workspace/worktrees/<name>-<job id>` there (issue #1103); absent, none. */
  trees?: { path: string; ageMs: number }[];
  /**
   * Each work tree asked about whose scratch area (`.hopper-scratch`) is there (issue #1120): a kept job's scratch dir
   * missing from one of these is gone. Absent (a client older than this), none is known.
   */
  roots?: string[];
  /**
   * The hopper's own disk use there (issue #1120): for each work tree in `roots`, the bytes its scratch area and its job
   * worktrees hold. Absent or empty: not measured (a client older than this, a machine with no `timeout`, a slow disk).
   */
  usage?: { path: string; bytes: number }[];
  /** Jobs with a container or a volume labelled with their id there (issue #1120); absent (a client older than this), none known. */
  containers?: string[];
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
   * Writes `content` to `file` under `dir`, the job's own credentials dir (`…/.hopper-scratch/<job id>/credentials`),
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
}
