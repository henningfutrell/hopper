// Issue #1141: tagged items — the open issues and pull requests where the user is a requested reviewer, is mentioned, or is
// assigned. Merged per item, dismissed only for the reasons they had, and each new review request recorded once.
import { describe, expect, it } from 'vitest';
import { NO_TAGGED_RECORD, dismissTagged, mergeTagged, shownTagged, startTagged, taggedRead, type TaggedHit } from '../../src/domain/tagged.ts';

const hit = (n: number, why: TaggedHit['why'], updatedAt = `2026-10-14T0${n}:00:00.000Z`): TaggedHit => ({
  key: `https://github.com/owner/repo/pull/${n}`, repo: 'owner/repo', number: n, kind: 'pull', title: `PR ${n}`, author: 'someone',
  why, createdAt: '2026-10-13T00:00:00.000Z', updatedAt, checks: 'passing',
});

describe('tagged items (issue #1141)', () => {
  it('merges the hits per item, with every reason, newest change first', () => {
    const items = mergeTagged([hit(1, 'mention'), hit(2, 'review'), hit(1, 'review'), hit(1, 'mention')]);
    expect(items.map((i) => [i.number, i.why])).toEqual([[2, ['review']], [1, ['review', 'mention']]]);
  });

  it('records each new review request once, and forgets one that is gone', () => {
    const first = taggedRead(NO_TAGGED_RECORD, mergeTagged([hit(1, 'review'), hit(2, 'mention')]));
    expect(first.newReviews.map((i) => i.number)).toEqual([1]);
    const again = taggedRead(first.record, mergeTagged([hit(1, 'review')]));
    expect(again.newReviews).toEqual([]);
    // Reviewed: the request is gone. Asked again later: a new request.
    const reviewed = taggedRead(again.record, []);
    expect(reviewed.record.reviewRequested).toEqual([]);
    expect(taggedRead(reviewed.record, mergeTagged([hit(1, 'review')])).newReviews.map((i) => i.number)).toEqual([1]);
  });

  it('a dismissal hides the item for the reasons it had, and a new reason shows it again', () => {
    const items = mergeTagged([hit(1, 'mention'), hit(2, 'review')]);
    const d = dismissTagged(NO_TAGGED_RECORD, items, [items[1]!.key, 'https://github.com/owner/repo/pull/9']);
    expect(d.done).toEqual([items[1]!.key]);
    expect(Object.keys(d.failed)).toEqual(['https://github.com/owner/repo/pull/9']);
    expect(shownTagged(items, d.record).map((i) => i.number)).toEqual([2]);
    const more = mergeTagged([hit(1, 'mention'), hit(1, 'review'), hit(2, 'review')]);
    expect(shownTagged(more, taggedRead(d.record, more).record).map((i) => i.number)).toEqual([2, 1]);
  });

  it('a dismissal ends once its item is no longer tagged for its reasons', () => {
    const items = mergeTagged([hit(1, 'review')]);
    const d = dismissTagged(NO_TAGGED_RECORD, items, [items[0]!.key]);
    const gone = taggedRead(d.record, []);
    expect(gone.record.dismissed).toEqual([]);
    expect(shownTagged(items, gone.record).map((i) => i.number)).toEqual([1]);
  });
});

describe('starting a job from a tagged item (issue #2342)', () => {
  const started = (key: string) => ({ key, start: 'research' as const, directJob: 'd1', jobId: 'j1', at: '2026-10-21T00:00:00.000Z' });

  it('a start shows on its item while it is tagged, and ends once it is no longer tagged', () => {
    const items = mergeTagged([hit(1, 'review'), hit(2, 'mention')]);
    const s = startTagged(NO_TAGGED_RECORD, items, started(items[1]!.key));
    expect(s.done).toEqual([items[1]!.key]);
    expect(shownTagged(items, s.record).map((i) => [i.number, i.started?.directJob])).toEqual([[2, undefined], [1, 'd1']]);
    expect(taggedRead(s.record, items).record.started).toEqual([started(items[1]!.key)]);
    expect(taggedRead(s.record, mergeTagged([hit(2, 'mention')])).record.started).toEqual([]);
  });

  it('starts an item once, and only one the last read listed', () => {
    const items = mergeTagged([hit(1, 'review')]);
    const once = startTagged(NO_TAGGED_RECORD, items, started(items[0]!.key));
    const twice = startTagged(once.record, items, { ...started(items[0]!.key), directJob: 'd2' });
    expect(twice.failed).toEqual({ [items[0]!.key]: 'already started: direct job d1' });
    expect(twice.record.started).toEqual([started(items[0]!.key)]);
    expect(startTagged(NO_TAGGED_RECORD, items, started('https://github.com/owner/repo/pull/9')).failed)
      .toEqual({ 'https://github.com/owner/repo/pull/9': 'not a tagged item the last sync listed' });
  });

  it('a record kept before starts existed reads as none started', () => {
    const items = mergeTagged([hit(1, 'review')]);
    expect(shownTagged(items, { reviewRequested: [], dismissed: [] })[0]!.started).toBeUndefined();
    expect(taggedRead({ reviewRequested: [], dismissed: [] }, items).record.started).toEqual([]);
  });
});
