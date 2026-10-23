// A bastion as the job and a person read it (issue #2146, design.md "Bastions"): the one sandbox that outlives a step.
// The bastions themselves are kept in memory by src/sandbox/bastions.ts; the vault's view lists those that run.

/** Why a bastion ended: the job or a person stopped it, its TTL passed, its job ended, or a mint or its box failed. */
export type BastionEnd = 'stopped' | 'expired' | 'job-ended' | 'failed';

/** A bastion as the job and a person read it. */
export interface BastionView {
  id: string;
  jobId: string;
  template: string;
  box: string;
  /**
   * Each target. `listening` (issue #2413): its forward listens, as its kubectl said; false with `said`, the last thing
   * kubectl said, once its forward ended; absent while it said nothing yet. `local` (issue #2566): the port on 127.0.0.1
   * in the box kubectl picked and said it forwards from; absent until it said so.
   */
  targets: { target: string; local?: number; listening?: boolean; said?: string }[];
  /** The vault secrets it holds for bastion reads (issue #2146 part 6), by name: each a header file in its box. Never a value. */
  secrets?: string[];
  state: 'starting' | 'running' | 'ended';
  startedAt: string;
  /** When its TTL ends, unless it is used before. */
  expiresAt: string;
  endedAt?: string;
  ended?: BastionEnd;
  endedBy?: string;
  problem?: string;
  /** The tail of its output: each forward's lines, marked with its target. Never a token. */
  log: string;
}
