// The shrink guard in the UI (issue #1096), pure: what the panel says is on now, and the check of a new percent.
import { describe, expect, it } from 'vitest';
import { percentDraft, SHRINK_GUARD_NOTE, shrinkGuardSummary } from '../../ui/src/model/shrink-guard.ts';

describe('the Shrink guard panel', () => {
  it('says what a push may take', () => {
    expect(shrinkGuardSummary({ percent: 50 })).toBe('A push that brings in the base branch is refused when it takes more than 50% of a file\'s lines, or empties or removes the file.');
    expect(shrinkGuardSummary({ percent: 100 })).toBe('A push that brings in the base branch is refused when it empties or removes a file.');
  });

  it('the note says what is never refused', () => {
    expect(SHRINK_GUARD_NOTE).toContain('your pull request');
    expect(SHRINK_GUARD_NOTE).toContain('tending failed');
  });

  it('a new percent: a whole number from 1 to 100; the saved one is no change', () => {
    expect(percentDraft(50, '30')).toEqual({ ok: true, percent: 30 });
    expect(percentDraft(50, ' 50 ')).toEqual({ ok: true });
    for (const bad of ['0', '101', '2.5', 'x', '']) expect(percentDraft(50, bad)).toEqual({ ok: false, error: 'A whole number from 1 to 100' });
  });
});
