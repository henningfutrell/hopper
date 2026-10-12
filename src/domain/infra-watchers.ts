// Environment watchers (issue #870 part 4, design.md "Infra plans: environment watchers"): who is told of each plan,
// its approval and its apply, by the environments the plan names. A watcher is a name as the notifier's receiver knows
// it (a handle, a team, a channel): the hopper sends the names with each notification, and the receiver tells them. `*`
// names the watchers of every plan, one that names no environment too. And a plan's notice: what a notification of the
// plan says. Never the plan's text or file. Pure.
import type { Asset } from './access.ts';
import { PLAN_ENVIRONMENTS, type PlanLevel, type PlanRisk } from './infra-plan-summary.ts';
import { approverOf, type InfraPlan, type PlanApproval, type PlanApprover, type PlanTool } from './infra-plans.ts';

/** The watchers of each environment, by its name (`prod`, `uat`, …), and of every environment (`*`). */
export type InfraWatchers = Record<string, string[]>;
export const EVERY_ENVIRONMENT = '*';
/** The most watchers one environment has. */
export const WATCHERS_MAX = 50;
const WATCHER = /^[^\n\r,]{1,100}$/;

/** Why `w` is not a watchers list the hopper keeps, or undefined. */
export function watchersProblem(w: InfraWatchers): string | undefined {
  const known = [EVERY_ENVIRONMENT, ...PLAN_ENVIRONMENTS];
  for (const [env, names] of Object.entries(w)) {
    if (!known.includes(env)) return `${env} is not an environment the hopper knows: ${known.join(', ')}`;
    if (names.length > WATCHERS_MAX) return `${env}: at most ${WATCHERS_MAX} watchers`;
    for (const n of names) if (!WATCHER.test(n.trim())) return `${env}: a watcher is one line of 1 to 100 characters, with no comma`;
  }
  return undefined;
}

/** The list as kept: each name trimmed and once, no environment with no watcher, in the order the hopper knows them. */
export function normalWatchers(w: InfraWatchers): InfraWatchers {
  const out: InfraWatchers = {};
  for (const env of [EVERY_ENVIRONMENT, ...PLAN_ENVIRONMENTS]) {
    const names = [...new Set((w[env] ?? []).map((n) => n.trim()))];
    if (names.length > 0) out[env] = names;
  }
  return out;
}

/** Who watches a plan in `environments`: the watchers of every environment, then of each one named; each once. */
export const watchersOf = (environments: readonly string[], w: InfraWatchers): string[] =>
  [...new Set([EVERY_ENVIRONMENT, ...environments].flatMap((env) => w[env] ?? []))];

/** What a notification of a plan says (issue #870 part 4): what it changes, where, its risk, who approves it, who watches it. */
export interface InfraPlanNotice {
  plan: string;
  tool: PlanTool;
  asset: Asset;
  target: string;
  repo: string;
  ref: string;
  commit: string;
  pullRequest?: number;
  /** The item the job runs: who asked for the change. */
  issue?: string;
  /** Absent with `level` and `blastRadius` on a plan kept before summaries. */
  words?: string;
  level?: PlanLevel;
  risks: PlanRisk[];
  environments: string[];
  blastRadius?: string;
  failed: boolean;
  approver: { who: PlanApprover; why: string };
  approval?: PlanApproval;
  watchers: string[];
}

export function planNotice(plan: InfraPlan, approval: PlanApproval | undefined, w: InfraWatchers): InfraPlanNotice {
  const s = plan.summary;
  const environments = s?.environments ?? [];
  return {
    plan: plan.id, tool: plan.tool, asset: plan.asset, target: plan.target, repo: plan.repo, ref: plan.ref, commit: plan.commit,
    ...(plan.pullRequest !== undefined ? { pullRequest: plan.pullRequest } : {}), ...(plan.issue ? { issue: plan.issue } : {}),
    ...(s ? { words: s.words, level: s.level } : {}), risks: s?.risks.map((r) => r.risk) ?? [], environments,
    ...(s ? { blastRadius: s.blastRadius } : {}), failed: s?.failed ?? false, approver: approverOf(plan),
    ...(approval ? { approval } : {}), watchers: watchersOf(environments, w),
  };
}
