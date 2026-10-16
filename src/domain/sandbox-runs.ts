// The sandbox runs (issue #1349, design.md "Sandboxes are burned after each step"): one per sandbox the hopper made for
// one step of a job — a need step or a box step —, from its start to its burn. A sandbox does one step and is burned:
// it is no machine and has no lane, so this ledger is the one place that says what ran where, and that it went.

/** How a sandbox run ended: its step's command exited 0, exited otherwise or did not run, or a sweep burned it. */
export type SandboxRunOutcome = 'succeeded' | 'failed' | 'swept';

export interface SandboxRun {
  /** The step's id: one sandbox per step. */
  id: string;
  userId: string;
  jobId: string;
  /** The template the sandbox was made of. */
  template: string;
  /** The sandbox's container name (`hopper-need-…`). */
  box: string;
  /** Where it ran: `local` (beside the hopper), or a client target's name. */
  machine: string;
  startedAt: string;
  endedAt?: string;
  outcome?: SandboxRunOutcome;
  /** The step's exit code. */
  exit?: number;
  /** Why the step did not end well, as the hopper said it. */
  problem?: string;
  /** When its container and home volume were seen gone: absent, the sandbox may still be there, and the sweep burns it. */
  destroyedAt?: string;
}

/** The sandbox runs, in the instance's `sandbox_runs` table. */
export interface SandboxRunRepository {
  start(run: SandboxRun): void;
  /** The step ended: its exit code and outcome. A run ended already keeps its end. */
  end(id: string, e: { at: string; exit?: number; outcome: SandboxRunOutcome; problem?: string }): void;
  /** Its container and home volume are gone. */
  destroyed(id: string, at: string): void;
  get(id: string): SandboxRun | undefined;
  /** The runs not seen destroyed yet, oldest first. */
  open(): SandboxRun[];
  /** The user's latest runs, newest first. */
  latest(userId: string, limit: number): SandboxRun[];
}

/** The outcome of a step that ended with `exit` and maybe a problem. */
export const outcomeOf = (r: { exit: number; problem?: string }): SandboxRunOutcome => (r.exit === 0 && !r.problem ? 'succeeded' : 'failed');
