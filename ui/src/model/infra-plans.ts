// Infra changes (issue #870, design.md "Infra plans: no apply without a plan"), pure: one line per plan — what it changes,
// the asset an apply of it is minted a credential for, and the commit it was made at — its state now, and its explainer:
// the summary in plain words, the risk callouts, the blast radius and the checks.
import type { PlanView } from '../../../src/domain/types.ts';

export const planHeadline = (p: Omit<PlanView, 'approval'>): string =>
  `${p.tool}: ${p.target}, applied as ${p.asset.kind} ${p.asset.name}, from ${p.repo} ${p.ref} at ${p.commit.slice(0, 12)}${p.pullRequest !== undefined ? ` (pull request ${p.pullRequest})` : ''}`;

export type PlanState = { kind: 'waiting' | 'approved' | 'stale' | 'failed'; words: string };

/** Failed a check, waiting for a person, approved, or stale at `now` (ms): a failed or stale plan is applied by nothing. */
export function planState(p: PlanView, now: number): PlanState {
  if (p.summary?.failed) return { kind: 'failed', words: 'Failed its checks: nobody approves it. The job fixes the code and plans again' };
  const left = Date.parse(p.expiresAt) - now;
  if (left <= 0) return { kind: 'stale', words: 'Stale: the job plans again' };
  const minutes = `stale in ${Math.ceil(left / 60_000)} min`;
  return p.approval ? { kind: 'approved', words: `Approved by ${p.approval.by}: ${minutes}` } : { kind: 'waiting', words: `Waits for approval: ${minutes}` };
}

export interface PlanExplainer { words: string; level: 'low' | 'high'; lines: string[] }

/** What the plan changes in plain words, its risk, and why: each callout, the blast radius, each check. None for a plan kept before summaries. */
export function planExplainer(p: Pick<PlanView, 'summary'>): PlanExplainer | undefined {
  const s = p.summary;
  if (!s) return undefined;
  return {
    words: s.words, level: s.level,
    lines: [...s.risks.map((r) => r.words), `Blast radius: ${s.blastRadius}`, ...s.checks.map((c) => `${c.ok ? 'Passed' : 'Failed'}: ${c.words}`)],
  };
}
