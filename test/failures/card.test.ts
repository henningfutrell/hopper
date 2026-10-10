// A hand-off's card (issue #621): one plain sentence says what happened, from what the job's work shows at its source —
// its pull requests and its item — never from the raw error; one resolution is recommended, with why in a few words.
import { describe, expect, it } from 'vitest';
import type { HandoffReason, WorkPullRequest, WorkState } from '../../src/domain/types.ts';
import { handoffCard } from '../../src/failures/card.ts';

const URL = 'https://github.com/o/r/pull/';
const pr = (number: number, o: Partial<WorkPullRequest> = {}): WorkPullRequest =>
  ({ url: `${URL}${number}`, number, by: 'opened', state: 'open', draft: false, conflicting: false, ...o });
const work = (o: Partial<WorkState> = {}): WorkState => ({ item: 'open', pullRequests: [], checkedAt: '2026-10-10T10:00:00.000Z', ...o });
const card = (w: WorkState | undefined, reason: HandoffReason = 'person', continueResumes = true) => handoffCard({ reason, ...(w ? { work: w } : {}) }, continueResumes);

describe('what happened, from the work state', () => {
  it('the job updated a pull request that is merged, its issue done: says so, and recommends Done', () => {
    expect(card(work({ item: 'done', pullRequests: [pr(616, { by: 'updated', state: 'merged' })] }))).toEqual({
      whatHappened: 'The job updated PR #616. #616 is merged. The issue is done.',
      recommended: 'done_by_hand', why: 'The work is done.', link: `${URL}616`,
    });
  });

  it('a merged pull request, its issue still open: says the issue is open', () => {
    expect(card(work({ pullRequests: [pr(7, { state: 'merged' })] })).whatHappened).toBe('The job opened PR #7. #7 is merged. The issue is still open.');
  });

  it('no pull request: the job stopped before it opened one; Continue its session with a note', () => {
    expect(card(work())).toEqual({
      whatHappened: 'The job stopped before it opened or updated a PR.',
      recommended: 'continue', why: 'Its session can go on. Tell it what to do in a note.',
    });
  });

  it('no pull request and a session that cannot resume: Continue runs a new job', () => {
    expect(card(work(), 'person', false).why).toBe('A new job starts. It gets the error and your note.');
  });

  it('an open pull request ready for review: Done, with its link', () => {
    expect(card(work({ pullRequests: [pr(9)] }))).toEqual({
      whatHappened: 'The job opened PR #9. #9 is open and ready for review.',
      recommended: 'done_by_hand', why: 'The PR is ready. Review and merge it.', link: `${URL}9`,
    });
  });

  it.each([
    ['a draft', { draft: true }, 'The job opened PR #9. #9 is a draft.', 'The job can finish the PR.'],
    ['with merge conflicts', { conflicting: true }, 'The job opened PR #9. #9 has merge conflicts.', 'The job can fix the conflicts.'],
  ])('an open pull request %s: Continue', (_n, o, whatHappened, why) => {
    expect(card(work({ pullRequests: [pr(9, o)] }))).toEqual({ whatHappened, recommended: 'continue', why });
  });

  it('a pull request closed without a merge: Run again', () => {
    expect(card(work({ pullRequests: [pr(9, { state: 'closed' })] }))).toEqual({
      whatHappened: 'The job opened PR #9. #9 is closed and not merged.',
      recommended: 'fixed', why: 'Its PR is closed. A new job can start again.',
    });
  });

  it('an item closed as not planned, or gone: Won\'t do', () => {
    expect(card(work({ item: 'closed' }))).toMatchObject({ whatHappened: 'The job stopped before it opened or updated a PR. The issue is closed and not done.', recommended: 'wont_do' });
    expect(card(work({ item: 'gone' }))).toMatchObject({ whatHappened: 'The job stopped before it opened or updated a PR. The issue is gone.', recommended: 'wont_do' });
  });

  it('two pull requests: the merged one first, then the other', () => {
    const c = card(work({ pullRequests: [pr(3, { state: 'closed' }), pr(4, { by: 'updated', state: 'merged' })] }));
    expect(c.whatHappened).toBe('The job updated PR #4. #4 is merged. The job opened PR #3. #3 is closed and not merged. The issue is still open.');
    expect(c.recommended).toBe('done_by_hand');
  });

  it('more than two pull requests: says how many more', () => {
    const c = card(work({ pullRequests: [pr(1), pr(2), pr(3), pr(4)] }));
    expect(c.whatHappened).toMatch(/ It has 2 more PRs\.$/);
  });
});

describe('before the work state is known', () => {
  it('says the hopper checks it, and recommends by why it was handed off', () => {
    expect(card(undefined)).toEqual({
      whatHappened: 'The job stopped with an error. The hopper is checking its PRs and its issue.',
      recommended: 'continue', why: 'Its session can go on. Tell it what to do in a note.',
    });
  });

  it.each([
    ['retry_limit', 'fixed', 'It failed the same way each time. Fix the cause, then run it again.'],
    ['auto_off', 'fixed', 'Automatic retry is off for this failure. Run it again when the cause is gone.'],
    ['not_retried', 'fixed', 'The hopper could not run it again. Remove the block, then run it again.'],
    ['dismissed', 'wont_do', 'It was removed from the queue with its failure open.'],
  ] as const)('handed off for %s, no pull request: recommends %s', (reason, recommended, why) => {
    expect(card(work(), reason)).toMatchObject({ recommended, why });
  });
});
