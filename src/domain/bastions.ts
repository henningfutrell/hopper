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
  /** Each target, and its port on 127.0.0.1 in the box. */
  targets: { target: string; local: number }[];
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
