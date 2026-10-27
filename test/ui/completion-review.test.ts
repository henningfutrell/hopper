// Completion reviews in the UI (ui/src/model/completion-review.ts, issue #2846), pure: the summary of the setting, the
// change a save sends — only what differs, refused when the minimum run time is not a number of minutes —, and a review's
// restarts and durations as people read them.
import { describe, expect, it } from 'vitest';
import { completionReviewPatch, completionReviewSummary, draftOf, durationText, modelReviewBy, modelReviewSummary, restartLine } from '../../ui/src/model/completion-review.ts';

const DEFAULTS = { on: true, outcomes: ['failed' as const], multiJob: true, minRunMinutes: 5, modelReview: { on: false, model: 'haiku', dailyCostUsd: 1 } };

describe('completion review model', () => {
  it('the summary says what is on', () => {
    expect(completionReviewSummary(DEFAULTS)).toBe('On: reviews failed jobs, and every job of a work item with more than one job, except a first run shorter than 5 min.');
    expect(completionReviewSummary({ ...DEFAULTS, outcomes: ['finished', 'failed'], multiJob: false, minRunMinutes: 0 })).toBe('On: reviews finished, failed jobs.');
    expect(completionReviewSummary({ ...DEFAULTS, outcomes: [], multiJob: false })).toBe('On, but no end is named: no job is reviewed.');
    expect(completionReviewSummary({ ...DEFAULTS, on: false })).toBe('Off: no ended job is reviewed.');
  });

  it('a save sends only what differs, the ends in the daemon\'s order; a bad minimum run time is refused', () => {
    const draft = { on: true, outcomes: ['failed' as const], multiJob: true, minRunMinutes: '5', modelOn: false, model: 'haiku', dailyCostUsd: '1' };
    expect(completionReviewPatch(DEFAULTS, draft)).toEqual({ ok: true, patch: undefined });
    expect(completionReviewPatch(DEFAULTS, { ...draft, outcomes: ['cancelled', 'finished', 'failed'] })).toEqual({ ok: true, patch: { outcomes: ['finished', 'failed', 'cancelled'] } });
    expect(completionReviewPatch(DEFAULTS, { ...draft, on: false, multiJob: false, minRunMinutes: ' 10 ' })).toEqual({ ok: true, patch: { on: false, multiJob: false, minRunMinutes: 10 } });
    expect(completionReviewPatch(DEFAULTS, { ...draft, minRunMinutes: '' })).toEqual({ ok: false, error: 'Minimum run time: a number from 0 to 1440' });
    expect(completionReviewPatch(DEFAULTS, { ...draft, minRunMinutes: '-1' }).ok).toBe(false);
  });

  it('the model review: its summary, a save of only the parts that differ, and a bad model or cap refused (issue #2846 part 3)', () => {
    expect(modelReviewSummary(DEFAULTS)).toBe('Model review off: only the rules review a run.');
    const on = { ...DEFAULTS, modelReview: { on: true, model: 'sonnet', dailyCostUsd: 2.5 } };
    expect(modelReviewSummary(on)).toBe('Model review on: sonnet reviews each kept review too, while the model reviews of the last day cost less than $2.5.');
    const draft = draftOf(DEFAULTS);
    expect(draft).toMatchObject({ modelOn: false, model: 'haiku', dailyCostUsd: '1' });
    expect(completionReviewPatch(DEFAULTS, { ...draft, modelOn: true })).toEqual({ ok: true, patch: { modelReview: { on: true } } });
    expect(completionReviewPatch(DEFAULTS, { ...draft, model: ' sonnet ', dailyCostUsd: '0.5' })).toEqual({ ok: true, patch: { modelReview: { model: 'sonnet', dailyCostUsd: 0.5 } } });
    expect(completionReviewPatch(DEFAULTS, { ...draft, model: 'two words' })).toEqual({ ok: false, error: 'Model: a model name, such as haiku or sonnet' });
    expect(completionReviewPatch(DEFAULTS, { ...draft, dailyCostUsd: '101' })).toEqual({ ok: false, error: 'Daily cost cap: a number of dollars from 0 to 100' });
    expect(modelReviewBy({ model: 'claude-haiku-4-5', costUsd: 0.0123 })).toBe('By claude-haiku-4-5 · $0.012');
    expect(modelReviewBy({})).toBe('By the model');
  });

  it('writes a restart and a duration as people read them', () => {
    expect(restartLine({ kind: 'preempted', count: 2, causes: ['a waits', 'b waits'] })).toBe('Preempted 2 times: a waits; b waits');
    expect(restartLine({ kind: 'link_lost', count: 1, causes: [] })).toBe('Lost the link to its machine once');
    expect(durationText(20_000)).toBe('under a minute');
    expect(durationText(65 * 60_000)).toBe('1 h 5 min');
  });
});
