// Issue #2845, part 2: grade-aware routing. At intake, with the user's grade routing on, a job goes to the executor whose
// graded jobs of the same work did best — the same repository and work kind when two executors have enough grades
// there, else the same work kind —; a user grade counts in place of the automatic grade. With too few grades to compare,
// the job keeps its executor. And the grade settings: what an admin may change, merged on the defaults. Pure.
import { describe, expect, it } from 'vitest';
import { gradeRouteOf, gradeSettingsOf } from '../../src/domain/grade-routing.ts';
import { DEFAULT_GRADE_SETTINGS, type GradeRow } from '../../src/domain/grades.ts';

let n = 0;
const row = (executor: string, score: number, o: Partial<GradeRow> = {}): GradeRow => ({
  jobId: `j${++n}`, endedAt: '2026-10-20T00:00:00.000Z', executor, kind: 'code', auto: { score, lines: [] }, ...o,
});
const many = (k: number, executor: string, score: number, o: Partial<GradeRow> = {}): GradeRow[] => Array.from({ length: k }, () => row(executor, score, o));
const EXECUTORS = ['claude', 'codex', 'opencode'];

describe('grade-aware routing (issue #2845)', () => {
  it('routes to the executor with the best mean grade on the same work kind', () => {
    const rows = [...many(3, 'claude', 40), ...many(3, 'codex', 85), ...many(3, 'codex', 90, { kind: 'research' })];
    expect(gradeRouteOf(rows, { kind: 'code' }, 'claude', EXECUTORS, 3)).toEqual({ executor: 'codex', from: 'claude', on: 'kind', score: 85, samples: 3, fromScore: 40, fromSamples: 3 });
  });

  it('keeps the executor when it does best, or when there are too few grades to compare', () => {
    expect(gradeRouteOf([...many(3, 'claude', 90), ...many(3, 'codex', 50)], { kind: 'code' }, 'claude', EXECUTORS, 3)).toBeUndefined();
    expect(gradeRouteOf([...many(2, 'claude', 10), ...many(3, 'codex', 90)], { kind: 'code' }, 'claude', EXECUTORS, 3)).toBeUndefined();
    expect(gradeRouteOf(many(3, 'codex', 90), { kind: 'code' }, 'claude', EXECUTORS, 3)).toBeUndefined();
  });

  it('takes the same repository first, and the work kind only when the repository has too few grades', () => {
    const repo = 'owner/app';
    const rows = [...many(3, 'claude', 90, { repo }), ...many(3, 'codex', 60, { repo }), ...many(5, 'codex', 99), ...many(5, 'claude', 20)];
    expect(gradeRouteOf(rows, { repo, kind: 'code' }, 'claude', EXECUTORS, 3)).toBeUndefined();
    expect(gradeRouteOf(rows, { repo: 'owner/other', kind: 'code' }, 'claude', EXECUTORS, 3)).toMatchObject({ executor: 'codex', on: 'kind' });
    expect(gradeRouteOf(rows, { repo: 'OWNER/App', kind: 'code' }, 'codex', EXECUTORS, 3)).toMatchObject({ executor: 'claude', on: 'repo', score: 90 });
  });

  it('counts a user grade in place of the automatic grade, and never routes to an executor that is not configured', () => {
    const rows = [...many(3, 'claude', 90, { user: { score: 1, by: 'p', at: '2026-10-21T00:00:00.000Z' } }), ...many(3, 'codex', 50), ...many(3, 'gone', 100)];
    expect(gradeRouteOf(rows, { kind: 'code' }, 'claude', EXECUTORS, 3)).toMatchObject({ executor: 'codex', fromScore: 0 });
  });
});

describe('the grade settings (issue #2845)', () => {
  it('are the defaults when never set, with grade routing off', () => {
    expect(gradeSettingsOf(undefined)).toEqual(DEFAULT_GRADE_SETTINGS);
    expect(DEFAULT_GRADE_SETTINGS.routing).toEqual({ on: false, minSamples: 10 });
  });

  it('merge what was kept on the defaults, weight by weight', () => {
    const s = gradeSettingsOf({ weights: { cost: 0 }, revertWindowDays: 3, routing: { on: true } });
    expect(s.weights).toEqual({ ...DEFAULT_GRADE_SETTINGS.weights, cost: 0 });
    expect(s).toMatchObject({ revertWindowDays: 3, routing: { on: true, minSamples: 10 }, costScaleUsd: DEFAULT_GRADE_SETTINGS.costScaleUsd });
  });
});
