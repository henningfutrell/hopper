// Push requirement metrics (issue #2555 part 5, design.md "Push requirements"): what the checks a job runs before it pushes
// saved, and what they let through. A check that stands for a CI check names it (`ci.checks`, globs of CI check names) and
// the billed minutes of a CI run that fails on it (`ci.minutes`). A **CI run caught** is a commit whose newest evaluation
// failed on such a check: the push gate kept it off CI. A **CI miss** is a CI run of a job's pull request that failed on a
// check such a check of a requirement that applied stands for: the evaluation should have caught it. Pure.
import { posix } from 'node:path';
import type { JudgedRequirement } from './push-requirements.ts';

/** A job's evaluation of a commit, as `push_requirements.evaluated` records it, with when. */
export interface EvaluatedPush { repo: string; head: string; at: string; passed: boolean; requirements: readonly JudgedRequirement[] }
/** A CI run that failed on a check a requirement that applied stands for, as `push_requirements.ci_missed` records it. */
export interface CiMiss { repo: string; pullRequest: string; head: string; checks: string[]; requirements: string[]; minutes?: number }

export interface RepoMetrics { repo: string; caught: number; minutesSaved: number; unpriced: number; missed: number; minutesMissed: number }
export interface PushRequirementMetrics extends Omit<RepoMetrics, 'repo'> { repos: RepoMetrics[] }

const matches = (globs: readonly string[], name: string): boolean => globs.some((g) => posix.matchesGlob(name.toLowerCase(), g.toLowerCase()));

/** The CI miss of a pull request whose head commit had this evaluation and whose CI failed on `failed`; undefined: none. */
export function ciMissOf(evaluation: Pick<EvaluatedPush, 'requirements'>, failed: readonly string[]): Omit<CiMiss, 'repo' | 'pullRequest' | 'head'> | undefined {
  const checks = new Set<string>(), requirements = new Set<string>();
  let minutes = 0;
  for (const q of evaluation.requirements) {
    if (q.status === 'skipped') continue;
    for (const c of q.checks ?? []) {
      const hit = c.ci ? failed.filter((f) => matches(c.ci!.checks, f)) : [];
      if (hit.length === 0) continue;
      for (const f of hit) checks.add(f);
      requirements.add(q.id);
      minutes = Math.max(minutes, c.ci!.minutes ?? 0);
    }
  }
  if (checks.size === 0) return undefined;
  return { checks: failed.filter((f) => checks.has(f)), requirements: [...requirements], ...(minutes > 0 ? { minutes } : {}) };
}

/** The billed minutes of the CI run a failed evaluation kept off CI; 0: no check that failed names any; undefined: it caught none. */
function caughtMinutes(e: EvaluatedPush): number | undefined {
  const failed = e.requirements.flatMap((q) => (q.status === 'failed' ? q.checks ?? [] : [])).filter((c) => !c.passed && c.ci);
  return failed.length === 0 ? undefined : Math.max(...failed.map((c) => c.ci!.minutes ?? 0));
}

/** The metrics of these evaluations and CI misses: each commit by its newest evaluation, each CI miss once. */
export function pushRequirementMetrics(evaluations: readonly EvaluatedPush[], misses: readonly CiMiss[]): PushRequirementMetrics {
  const repos = new Map<string, RepoMetrics>();
  const of = (repo: string): RepoMetrics => {
    const key = repo.toLowerCase();
    if (!repos.has(key)) repos.set(key, { repo, caught: 0, minutesSaved: 0, unpriced: 0, missed: 0, minutesMissed: 0 });
    return repos.get(key)!;
  };
  const newest = new Map<string, EvaluatedPush>();
  for (const e of evaluations) {
    const key = `${e.repo.toLowerCase()} ${e.head}`;
    const before = newest.get(key);
    if (!before || before.at <= e.at) newest.set(key, e);
  }
  for (const e of newest.values()) {
    const minutes = e.passed ? undefined : caughtMinutes(e);
    if (minutes === undefined) continue;
    const r = of(e.repo);
    r.caught++;
    if (minutes > 0) r.minutesSaved += minutes; else r.unpriced++;
  }
  const seen = new Set<string>();
  for (const m of misses) {
    const key = `${m.pullRequest} ${m.head}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = of(m.repo);
    r.missed++;
    r.minutesMissed += m.minutes ?? 0;
  }
  const list = [...repos.values()].sort((x, y) => x.repo.localeCompare(y.repo));
  const sum = (k: Exclude<keyof RepoMetrics, 'repo'>) => list.reduce((n, r) => n + r[k], 0);
  return { caught: sum('caught'), minutesSaved: sum('minutesSaved'), unpriced: sum('unpriced'), missed: sum('missed'), minutesMissed: sum('minutesMissed'), repos: list };
}
