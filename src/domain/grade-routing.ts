// Grade-aware routing (issue #2845, design.md "Grade-aware routing"): at intake, with the user's grade routing on, a job
// no routing rule gave an executor goes to the configured executor whose graded jobs of the same work did best — the
// same repository and work kind when the job's own executor and another have `minSamples` grades there, else the same
// work kind. A job's points are its user grade when a person gave one (1 is 0, 5 is 100), else its automatic grade. With
// too few grades to compare, or when its own executor does as well, the job keeps it. And the grade settings as kept:
// merged on the defaults, so a setting saved before a field existed reads that field's default. Pure.
import { DEFAULT_GRADE_SETTINGS, GRADE_SIGNALS, userPointsOf, type GradeRow, type GradeSettings, type GradeSignal } from './grades.ts';
import type { WorkKind } from './skill-library.ts';

/** Why grade-aware routing changed a job's executor (`spec.gradeRoute`): to and from, the scope it compared on, and each one's mean and count. */
export interface GradeRoute { executor: string; from: string; on: 'repo' | 'kind'; score: number; samples: number; fromScore: number; fromSamples: number }

/** The grade settings as a save may give them: every field optional, each weight on its own. */
export interface GradeSettingsPatch {
  weights?: Partial<Record<GradeSignal, number>>; revertWindowDays?: number; costScaleUsd?: number; timeScaleMinutes?: number;
  routing?: Partial<GradeSettings['routing']>;
}

/** `patch` merged on `base` (the defaults when none). */
export function gradeSettingsOf(patch: GradeSettingsPatch | undefined, base: GradeSettings = DEFAULT_GRADE_SETTINGS): GradeSettings {
  const p = patch ?? {};
  return {
    weights: Object.fromEntries(GRADE_SIGNALS.map((g) => [g, p.weights?.[g] ?? base.weights[g]])) as Record<GradeSignal, number>,
    revertWindowDays: p.revertWindowDays ?? base.revertWindowDays, costScaleUsd: p.costScaleUsd ?? base.costScaleUsd,
    timeScaleMinutes: p.timeScaleMinutes ?? base.timeScaleMinutes,
    routing: { on: p.routing?.on ?? base.routing.on, minSamples: p.routing?.minSamples ?? base.routing.minSamples },
  };
}

/** The grade settings the automatic grade reads: a change of them grades the kept grades again. */
export const gradingPartOf = (s: GradeSettings): string =>
  JSON.stringify({ weights: s.weights, revertWindowDays: s.revertWindowDays, costScaleUsd: s.costScaleUsd, timeScaleMinutes: s.timeScaleMinutes });

/** A graded job's points: its user grade when a person gave one, else its automatic grade. */
export const pointsOf = (r: GradeRow): number => (r.user ? userPointsOf(r.user.score) : r.auto.score);
const mean = (xs: number[]): number => Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10;

/** Each executor's mean points and count over the rows. */
function meansOf(rows: readonly GradeRow[]): Map<string, { score: number; samples: number }> {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.executor, [...(by.get(r.executor) ?? []), pointsOf(r)]);
  return new Map([...by].map(([e, xs]) => [e, { score: mean(xs), samples: xs.length }]));
}

/**
 * The executor grades prefer for `work` over `from`, or undefined: only one of `executors` (the configured ones), only
 * when `from` and it each have `minSamples` grades on the scope, and only when it has the higher mean.
 */
export function gradeRouteOf(
  rows: readonly GradeRow[], work: { repo?: string; kind: WorkKind }, from: string, executors: readonly string[], minSamples: number,
): GradeRoute | undefined {
  const known = new Set(executors);
  const ofKind = rows.filter((r) => r.kind === work.kind && known.has(r.executor));
  const repo = work.repo?.toLowerCase();
  const scopes: ['repo' | 'kind', GradeRow[]][] = [...(repo ? [['repo', ofKind.filter((r) => r.repo === repo)] as ['repo', GradeRow[]]] : []), ['kind', ofKind]];
  for (const [on, scoped] of scopes) {
    const means = [...meansOf(scoped)].filter(([, m]) => m.samples >= minSamples);
    const own = means.find(([e]) => e === from)?.[1];
    if (!own || means.length < 2) continue;
    const [executor, best] = means.sort(([a, x], [b, y]) => y.score - x.score || a.localeCompare(b))[0]!;
    return executor === from || best.score <= own.score ? undefined
      : { executor, from, on, score: best.score, samples: best.samples, fromScore: own.score, fromSamples: own.samples };
  }
  return undefined;
}
