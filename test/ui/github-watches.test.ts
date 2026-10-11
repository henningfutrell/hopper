// GitHub watches in the UI (ui/src/model/github-watches.ts, issue #427), pure: the interval in words, the change a save
// sends — refused when it is not a whole number of seconds in its range —, and one line per watch.
import { describe, expect, it } from 'vitest';
import { intervalPatch, intervalWords, watchLine } from '../../ui/src/model/github-watches.ts';

const pointer = { kind: 'issue' as const, number: 7, url: 'https://github.com/o/r/issues/7' };

describe('the GitHub watches model', () => {
  it('says the interval in words', () => {
    expect(intervalWords(60)).toBe('1 min');
    expect(intervalWords(90)).toBe('1 min 30 s');
    expect(intervalWords(45)).toBe('45 s');
    expect(intervalWords(7200)).toBe('120 min');
  });

  it('a save sends the new interval; the same one is nothing to save', () => {
    expect(intervalPatch(60, '60')).toEqual({ ok: true, patch: undefined });
    expect(intervalPatch(60, ' 300 ')).toEqual({ ok: true, patch: { intervalSeconds: 300 } });
  });

  it('a value out of range, a fraction or no number is refused', () => {
    for (const bad of ['5', '86401', '1.5', '', 'often']) expect(intervalPatch(60, bad)).toEqual({ ok: false, error: 'Interval: a whole number of seconds from 10 to 86400' });
  });

  it('a watch: what it watches, then its last poll, or why it cannot poll', () => {
    expect(watchLine({ pointedJob: 'p1', repo: 'o/r', pointer })).toBe('o/r#7: not polled yet');
    expect(watchLine({ pointedJob: 'p1', repo: 'o/r', pointer, error: 'GitHub answered 404' })).toBe('o/r#7: GitHub answered 404');
    const snapshot = { state: 'open' as const, labels: ['bug', 'ready'], comments: [{ id: 1, author: 'a', at: '' }], reviews: [], linkedPullRequests: [] };
    expect(watchLine({ pointedJob: 'p1', repo: 'o/r', pointer, snapshot, polledAt: '2026-10-11T12:00:00.000Z' }))
      .toBe('o/r#7: open, labels bug, ready, 1 comment; polled 2026-10-11 12:00:00 UTC');
  });
});
