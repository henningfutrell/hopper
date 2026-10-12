// The Infra page (issues #870, #896, design.md "Infra plans: no apply without a plan"), pure: one line per plan — what it
// changes, the asset an apply of it is minted a credential for, and the commit it was made at — its state now, who it
// waits for, and its explainer: the summary in plain words, the risk callouts, the blast radius and the checks. One line
// per apply, and the applies and drift timeline: plans, approvals, applies and out-of-band changes, newest first.
import type { OutOfBandView, PlanApply, PlanView } from '../../../src/domain/types.ts';
import { changeHeadline } from './out-of-band.ts';

export const planHeadline = (p: Omit<PlanView, 'approval'>): string =>
  `${p.tool}: ${p.target}, applied as ${p.asset.kind} ${p.asset.name}, from ${p.repo} ${p.ref} at ${p.commit.slice(0, 12)}${p.pullRequest !== undefined ? ` (pull request ${p.pullRequest})` : ''}`;

export type PlanState = { kind: 'waiting' | 'approved' | 'stale' | 'failed'; words: string };

/** Failed a check, waiting for an admin, approved, or stale at `now` (ms): a failed or stale plan is applied by nothing. */
export function planState(p: PlanView, now: number): PlanState {
  if (p.summary?.failed) return { kind: 'failed', words: 'Failed its checks: nobody approves it. The job fixes the code and plans again' };
  const left = Date.parse(p.expiresAt) - now;
  if (left <= 0) return { kind: 'stale', words: 'Stale: the job plans again' };
  const minutes = `stale in ${Math.ceil(left / 60_000)} min`;
  return p.approval ? { kind: 'approved', words: `Approved by ${p.approval.by}: ${minutes}` } : { kind: 'waiting', words: `Waits for an admin to approve it: ${minutes}` };
}

/** The plans that wait for an admin at `now` (issue #897: Needs you, the Infra badge); none for an answer with no plans. */
export const plansWaiting = (v: { plans?: PlanView[] } | undefined, now: number): number =>
  Array.isArray(v?.plans) ? v.plans.filter((p) => planState(p, now).kind === 'waiting').length : 0;

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

/** An API token's ask to approve the plan (issue #909): who asked, and that a person confirms it by approving it. */
export const askedLine = (a: NonNullable<PlanView['asked']>): string =>
  `${a.asker} asked to approve this through the API at ${a.at}. An API token does not approve a high-risk plan: approve it here to confirm it.`;

/** One apply: the operation, the asset, the job that asked, and until when the credential is valid. */
export const applyLine = (a: PlanApply): string =>
  `${a.operation} on ${a.asset.kind} ${a.asset.name} by job ${a.job.slice(0, 8)}, valid until ${a.expiresAt}${a.renewal ? ' (renewed)' : ''}`;

export interface TimelineEntry { at: string; kind: 'plan' | 'approved' | 'apply' | 'drift' | 'out-of-band' | 'marked'; words: string }

const DRIFT: readonly OutOfBandView['source'][] = ['gitops', 'terraform-plan'];

/** Plans recorded and approved, applies, drift and out-of-band writes, and their marks: one list, newest first. */
export function infraTimeline(plans: PlanView[], applies: PlanApply[], changes: OutOfBandView[]): TimelineEntry[] {
  const short = (id: string): string => id.slice(0, 8);
  const entries: TimelineEntry[] = [
    ...plans.flatMap((p): TimelineEntry[] => [
      { at: p.createdAt, kind: 'plan', words: `Plan ${short(p.id)} recorded: ${planHeadline(p)}` },
      ...(p.approval ? [{ at: p.approval.at, kind: 'approved' as const, words: `Plan ${short(p.id)} approved by ${p.approval.by}` }] : []),
    ]),
    ...applies.map((a): TimelineEntry => ({ at: a.at, kind: 'apply', words: `Applied plan ${short(a.plan)}: ${applyLine(a)}` })),
    ...changes.flatMap((c): TimelineEntry[] => [
      { at: c.at, kind: DRIFT.includes(c.source) ? 'drift' : 'out-of-band', words: changeHeadline(c) },
      ...(c.marked ? [{ at: c.marked.at, kind: 'marked' as const, words: `Change ${short(c.id)}: ${c.marked.mark} by ${c.marked.by}${c.marked.reason ? `: ${c.marked.reason}` : ''}` }] : []),
    ]),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
