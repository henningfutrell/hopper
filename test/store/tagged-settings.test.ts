// Issue #1141: what a job source keeps of its tagged items is a key-value setting per source instance, absent until set.
import { describe, expect, it } from 'vitest';
import { taggedSettings } from '../../src/store/tagged-settings.ts';

describe('tagged items in the settings (issue #1141)', () => {
  it('keeps each source\'s record apart, and only its fields', () => {
    const kept = new Map<string, string>();
    const s = taggedSettings((k) => kept.get(k), (k, v) => { kept.set(k, v); });
    expect(s.getTaggedRecord('github')).toBeUndefined();
    const record = { reviewRequested: ['https://github.com/o/r/pull/1'], dismissed: [{ key: 'https://github.com/o/r/pull/2', why: ['mention' as const], extra: 1 }] };
    s.setTaggedRecord('github', record);
    expect(s.getTaggedRecord('github')).toEqual({ reviewRequested: ['https://github.com/o/r/pull/1'], dismissed: [{ key: 'https://github.com/o/r/pull/2', why: ['mention'] }] });
    expect(s.getTaggedRecord('other')).toBeUndefined();
  });

  it('keeps the jobs started from Tagged, and only their fields (issue #2342)', () => {
    const kept = new Map<string, string>();
    const s = taggedSettings((k) => kept.get(k), (k, v) => { kept.set(k, v); });
    const started = { key: 'https://github.com/o/r/pull/1', start: 'work' as const, work: 'review' as const, directJob: 'd1', jobId: 'j1', at: '2026-10-21T00:00:00.000Z' };
    s.setTaggedRecord('github', { reviewRequested: [], dismissed: [], started: [{ ...started, extra: 1 } as typeof started] });
    expect(s.getTaggedRecord('github')).toEqual({ reviewRequested: [], dismissed: [], started: [started] });
  });
});
