// Infra changes (issue #870, design.md "Infra plans: no apply without a plan"), pure: one line per plan — what it changes,
// the asset an apply of it is minted a credential for, and the commit it was made at — and its state now.
import type { PlanView } from '../../../src/domain/types.ts';

export const planHeadline = (p: Omit<PlanView, 'approval'>): string =>
  `${p.tool}: ${p.target}, applied as ${p.asset.kind} ${p.asset.name}, from ${p.repo} ${p.ref} at ${p.commit.slice(0, 12)}${p.pullRequest !== undefined ? ` (pull request ${p.pullRequest})` : ''}`;

export type PlanState = { kind: 'waiting' | 'approved' | 'stale'; words: string };

/** Waiting for a person, approved, or stale at `now` (ms): a stale plan is applied by nothing. */
export function planState(p: PlanView, now: number): PlanState {
  const left = Date.parse(p.expiresAt) - now;
  if (left <= 0) return { kind: 'stale', words: 'Stale: the job plans again' };
  const minutes = `stale in ${Math.ceil(left / 60_000)} min`;
  return p.approval ? { kind: 'approved', words: `Approved by ${p.approval.by}: ${minutes}` } : { kind: 'waiting', words: `Waits for approval: ${minutes}` };
}
