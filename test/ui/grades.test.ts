// Grades in the UI (ui/src/model/grades.ts, issue #2845), pure: a signal's line and a score's tone, a user grade and its
// disagreement as people read them, the summary of the grade settings, and the change a save sends — only what differs,
// each weight on its own, refused when a field is out of the daemon's range.
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADE_SETTINGS } from '../../src/domain/grades.ts';
import { draftOf, gradeLineText, gradeSettingsPatch, gradeSettingsSummary, scoreTone, userGradeText } from '../../ui/src/model/grades.ts';

describe('grades model', () => {
  it('writes a signal line, a score\'s tone and a user grade as people read them', () => {
    expect(gradeLineText({ signal: 'pull_request', value: 0, weight: 3, why: 'merged, then reverted by https://github.com/o/r/pull/9' }))
      .toBe('Pull request: merged, then reverted by https://github.com/o/r/pull/9 (0 of 100, weight 3)');
    expect(gradeLineText({ signal: 'rework', value: 0.5, weight: 2, why: '1 rework, 0 run again, 0 retry' })).toBe('Rework: 1 rework, 0 run again, 0 retry (50 of 100, weight 2)');
    expect([scoreTone(85), scoreTone(55), scoreTone(20)]).toEqual(['ok', 'warn', 'bad']);
    expect(userGradeText({ score: 4, note: 'good tests', by: 'someone', at: '2026-10-26T12:30:00.000Z' })).toBe('4 of 5 by someone, 2026-10-26 12:30 UTC: good tests');
    expect(userGradeText({ score: 2, by: 'someone', at: '2026-10-26T12:30:00.000Z' })).toBe('2 of 5 by someone, 2026-10-26 12:30 UTC');
  });

  it('the summary says what grade-aware routing does', () => {
    expect(gradeSettingsSummary(DEFAULT_GRADE_SETTINGS)).toBe('Grade-aware routing is off: grades are kept and shown, and intake does not read them.');
    expect(gradeSettingsSummary({ ...DEFAULT_GRADE_SETTINGS, routing: { on: true, minSamples: 3 } }))
      .toBe('Grade-aware routing is on: intake gives a new job the executor graded best on matching work, when each executor has 3 graded jobs there.');
  });

  it('a save sends only what differs, each weight on its own; a bad field is refused', () => {
    const draft = draftOf(DEFAULT_GRADE_SETTINGS);
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, draft)).toEqual({ ok: true, patch: undefined });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, weights: { ...draft.weights, cost: ' 0 ' }, routingOn: true, minSamples: '5' }))
      .toEqual({ ok: true, patch: { weights: { cost: 0 }, routing: { on: true, minSamples: 5 } } });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, revertWindowDays: '14', costScaleUsd: '2.5', timeScaleMinutes: '60' }))
      .toEqual({ ok: true, patch: { revertWindowDays: 14, costScaleUsd: 2.5, timeScaleMinutes: 60 } });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, weights: { ...draft.weights, outcome: '101' } })).toEqual({ ok: false, error: 'Weight of Outcome: a number from 0 to 100' });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, revertWindowDays: '0' })).toEqual({ ok: false, error: 'Revert window: a whole number of days from 1 to 90' });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, costScaleUsd: '0' })).toEqual({ ok: false, error: 'Cost scale: a number above 0, up to 10000' });
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, timeScaleMinutes: '1.5' }).ok).toBe(false);
    expect(gradeSettingsPatch(DEFAULT_GRADE_SETTINGS, { ...draft, minSamples: '' })).toEqual({ ok: false, error: 'Minimum graded jobs: a whole number from 1 to 10000' });
  });
});
