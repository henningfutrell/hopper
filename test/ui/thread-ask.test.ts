// Asking on the issue thread in the UI (issue #435): the settings summary, the change a save sends, and what a question's
// card says of its thread.
import { describe, expect, it } from 'vitest';
import { awaitsThreadReview, threadAskPatch, threadAskSummary, threadLine } from '../../ui/src/model/thread-ask.ts';

describe('the issue thread in the UI', () => {
  it('the summary says what happens in own and other repositories', () => {
    expect(threadAskSummary({ ownRepos: 'post', otherRepos: 'review' })).toBe('In your own repositories, the hopper will post the question on the issue at once; in other repositories, it will hold the question until you approve it.');
    expect(threadAskSummary({ ownRepos: 'post', otherRepos: 'post' })).toBe('In every repository, the hopper will post the question on the issue at once.');
    expect(threadAskSummary({ ownRepos: 'off', otherRepos: 'off' })).toBe('Off: no question goes on an issue thread.');
  });

  it('a save sends only what changed', () => {
    const s = { ownRepos: 'post', otherRepos: 'review' } as const;
    expect(threadAskPatch(s, s)).toBeUndefined();
    expect(threadAskPatch(s, { ...s, otherRepos: 'off' })).toEqual({ otherRepos: 'off' });
  });

  it('the card says where the question is, and only a held open one waits for approval', () => {
    const at = '2026-10-11T00:00:00.000Z';
    expect(threadLine({})).toBeUndefined();
    expect(threadLine({ thread: { state: 'review', at } })).toMatch(/review/);
    expect(threadLine({ thread: { state: 'posted', at, url: 'u' } })).toMatch(/reply there answers it/);
    expect(awaitsThreadReview({ status: 'open', thread: { state: 'review', at } })).toBe(true);
    expect(awaitsThreadReview({ status: 'answered', thread: { state: 'review', at } })).toBe(false);
    expect(awaitsThreadReview({ status: 'open', thread: { state: 'posted', at } })).toBe(false);
  });
});
