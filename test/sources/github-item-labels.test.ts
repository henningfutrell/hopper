// Labels mirror the database (issues #1891, #1933): the end labels an issue should carry are a pure function of its work item's
// state, and a drift is what a discover saw against them.
import { describe, expect, it } from 'vitest';
import { HANDOFF_WAIT } from '../../src/domain/work-items.ts';
import { DELIBERATE_CANCELS } from '../../src/domain/types.ts';
import { blockLabels, doneReported, dropReported, labelDrift, labelPutOn, labelsFor, labelTakenOff } from '../../src/sources/github/item-labels.ts';

describe('labelsFor: the end labels a state wants (issue #1891)', () => {
  it('a job at work: no end label', () => {
    for (const state of ['queued', 'working', 'waiting_outside'] as const) expect(labelsFor({ state })).toEqual({ allowed: [] });
  });

  it('PR open: its waiting label, of a whole pull request or of a part', () => {
    expect(labelsFor({ state: 'pr_open' })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:pr-ready' });
    expect(labelsFor({ state: 'pr_open' }, { part: true })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:partly-done' });
  });

  it('blocked: hopper:blocked, or hopper:pr-closed when its pull request was closed without a merge; none for want of a pull request (issue #2693)', () => {
    expect(labelsFor({ state: 'blocked', blockedCause: 'no_pr' })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'blocked', blockedCause: 'stale' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
    expect(labelsFor({ state: 'blocked', blockedCause: 'pr_closed' })).toEqual({ allowed: ['hopper:pr-closed'], add: 'hopper:pr-closed' });
  });

  it('failed (issue #1892): hopper:failed once its job\'s failure was reported as failed; not judged before, nor a reverted culprit not of a whole merge', () => {
    expect(labelsFor({ state: 'failed', eventState: 'failed' }, { failureReported: true })).toEqual({ allowed: ['hopper:failed'], add: 'hopper:failed' });
    expect(labelsFor({ state: 'failed', eventState: 'failed' })).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'done' }, { failureReported: true })).toBeUndefined();
    expect(labelTakenOff({ state: 'failed', eventState: 'failed' }, ['hopper', 'hopper:failed'], ['hopper'], { failureReported: true })).toBe('hopper:failed');
  });

  it('failed, told as one the hopper fixes itself (issue #1892 part 31): no end label; not a reverted culprit', () => {
    const fixing = { state: 'failed', eventState: 'failed' } as const;
    expect(labelsFor(fixing, { fixingReported: true })).toEqual({ allowed: [] });
    expect(labelDrift(fixing, ['hopper', 'hopper:claimed', 'hopper:failed'], { fixingReported: true })).toEqual({ remove: ['hopper:failed'], add: [] });
    expect(labelTakenOff(fixing, ['hopper', 'hopper:failed'], ['hopper'], { fixingReported: true })).toBeUndefined();
    expect(labelPutOn(fixing, ['hopper'], ['hopper', 'hopper:failed'], { fixingReported: true })).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'done' }, { fixingReported: true })).toBeUndefined();
  });

  it('failed, its report not out yet (issue #1892 part 32): hopper:failed allowed, none added; no person event', () => {
    const waits = { state: 'failed', eventState: 'failed' } as const;
    expect(labelsFor(waits, { failureReportWaits: true })).toEqual({ allowed: ['hopper:failed'] });
    expect(labelDrift(waits, ['hopper', 'hopper:claimed'], { failureReportWaits: true })).toBeUndefined();
    expect(labelDrift(waits, ['hopper', 'hopper:failed'], { failureReportWaits: true })).toBeUndefined();
    expect(labelDrift(waits, ['hopper', 'hopper:pr-ready', 'hopper:failed'], { failureReportWaits: true })).toEqual({ remove: ['hopper:pr-ready'], add: [] });
    expect(labelTakenOff(waits, ['hopper', 'hopper:failed'], ['hopper'], { failureReportWaits: true })).toBeUndefined();
    expect(labelPutOn(waits, ['hopper'], ['hopper', 'hopper:failed'], { failureReportWaits: true })).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'done' }, { failureReportWaits: true })).toBeUndefined();
  });

  it('failed by its landing, a reverted culprit of a whole merge (issue #1892 part 33): hopper:done, as the follow put it on', () => {
    const culprit = { state: 'failed', eventState: 'done', pullRequestState: 'merged', wholeMerged: true } as const;
    expect(labelsFor(culprit)).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelDrift(culprit, ['hopper', 'hopper:failed'])).toEqual({ remove: ['hopper:failed'], add: ['hopper:done'] });
    expect(labelTakenOff(culprit, ['hopper', 'hopper:done'], ['hopper'])).toBe('hopper:done');
    expect(labelsFor({ state: 'failed', eventState: 'partly_done', pullRequestState: 'merged' })).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'done', pullRequestState: 'merged' })).toBeUndefined();
  });

  it('failed by its landing, a reverted culprit of a part with parts left (issue #1892 part 34): no end label, as the follow left it', () => {
    const culprit = { state: 'failed', eventState: 'partly_done', pullRequestState: 'merged' } as const;
    expect(labelsFor(culprit, { partsLeft: true })).toEqual({ allowed: [] });
    expect(labelDrift(culprit, ['hopper', 'hopper:partly-done'], { partsLeft: true })).toEqual({ remove: ['hopper:partly-done'], add: [] });
    expect(labelTakenOff(culprit, ['hopper', 'hopper:partly-done'], ['hopper'], { partsLeft: true })).toBeUndefined();
    expect(labelPutOn(culprit, ['hopper'], ['hopper', 'hopper:done'], { partsLeft: true })).toBeUndefined();
    expect(labelsFor(culprit)).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'failed', pullRequestState: 'merged' }, { partsLeft: true })).toBeUndefined();
  });

  it('failed by its landing, a reverted culprit of the last part (issue #1892 part 35): hopper:done, as the follow put it on', () => {
    const culprit = { state: 'failed', eventState: 'partly_done', pullRequestState: 'merged' } as const;
    expect(labelsFor(culprit, { lastPartMerged: true })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelDrift(culprit, ['hopper', 'hopper:partly-done'], { lastPartMerged: true })).toEqual({ remove: ['hopper:partly-done'], add: ['hopper:done'] });
    expect(labelTakenOff(culprit, ['hopper', 'hopper:done'], ['hopper'], { lastPartMerged: true })).toBe('hopper:done');
    expect(labelsFor({ state: 'failed', eventState: 'failed', pullRequestState: 'merged' }, { lastPartMerged: true })).toBeUndefined();
  });

  it('done (issue #1892): hopper:done once its pull request merged as the whole item; not judged else', () => {
    expect(labelsFor({ state: 'done', pullRequestState: 'merged', wholeMerged: true })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelsFor({ state: 'done', pullRequestState: 'merged' })).toBeUndefined();
    expect(labelsFor({ state: 'done', wholeMerged: true })).toBeUndefined();
    expect(labelTakenOff({ state: 'done', pullRequestState: 'merged', wholeMerged: true }, ['hopper', 'hopper:done'], ['hopper'])).toBe('hopper:done');
  });

  it('done by hand (issue #1892): hopper:done, and taking it off is a label edit; a done a job\'s end made is not judged', () => {
    const byHand = { state: 'done', eventState: 'done', doneByHand: true } as const;
    expect(labelsFor(byHand)).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelsFor({ state: 'done', eventState: 'done' })).toBeUndefined();
    expect(labelsFor({ state: 'done', eventState: 'failed', doneByHand: true })).toBeUndefined();
    expect(labelDrift(byHand, ['hopper', 'hopper:failed'])).toEqual({ remove: ['hopper:failed'], add: ['hopper:done'] });
    expect(labelTakenOff(byHand, ['hopper', 'hopper:done'], ['hopper'])).toBe('hopper:done');
  });

  it('done by a job\'s end whose report put hopper:done on (issue #1892 part 24): hopper:done; not judged before', () => {
    const ended = { state: 'done', eventState: 'done' } as const;
    expect(labelsFor(ended, { doneReported: 'closed' })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelsFor(ended, {})).toBeUndefined();
    expect(labelsFor({ state: 'done', eventState: 'pr_open' }, { doneReported: 'closed' })).toBeUndefined();
    expect(labelDrift(ended, ['hopper', 'hopper:blocked'], { doneReported: 'closed' })).toEqual({ remove: ['hopper:blocked'], add: ['hopper:done'] });
    expect(labelTakenOff(ended, ['hopper', 'hopper:done'], ['hopper'], { doneReported: 'closed' })).toBe('hopper:done');
  });

  it('done by a job\'s end whose report found the issue open (issue #1892 part 28): the label the report put on', () => {
    const ended = { state: 'done', eventState: 'done' } as const;
    expect(labelsFor(ended, { doneReported: 'pr_open' })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:pr-ready' });
    expect(labelsFor(ended, { doneReported: 'part' })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:partly-done' });
    expect(labelsFor(ended, { doneReported: 'no_pr' })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'done', eventState: 'blocked' }, { doneReported: 'no_pr' })).toBeUndefined();
    expect(labelDrift(ended, ['hopper', 'hopper:failed'], { doneReported: 'no_pr' })).toEqual({ remove: ['hopper:failed'], add: [] });
    expect(labelTakenOff(ended, ['hopper', 'hopper:blocked'], ['hopper'], { doneReported: 'no_pr' })).toBeUndefined();
  });

  it('doneReported: what a finished job\'s final report put on, the issue closed as complete or open', () => {
    const job = (status: string, sync: Record<string, unknown>, source?: Record<string, unknown>) =>
      ({ status, spec: {}, sourceState: { sync, ...(source ? { source } : {}) } }) as unknown as Parameters<typeof doneReported>[0];
    expect(doneReported(job('finished', { finalReported: true }, { doneReported: true }))).toBe('closed');
    expect(doneReported(job('finished', { finalReported: false }, { doneReported: true }))).toBeUndefined();
    expect(doneReported(job('finished', { finalReported: true }, { follow: 'open' }))).toBe('no_pr');
    expect(doneReported(job('finished', { finalReported: true }, { follow: 'open', pullRequest: 'https://github.com/o/r/pull/2' }))).toBe('pr_open');
    expect(doneReported(job('finished', { finalReported: true }, { follow: 'open', pullRequest: 'https://github.com/o/r/pull/2', part: true }))).toBe('part');
    expect(doneReported(job('finished', { finalReported: true }, { follow: 'merged', pullRequest: 'https://github.com/o/r/pull/2' }))).toBeUndefined();
    expect(doneReported(job('finished', { finalReported: false }, { follow: 'open' }))).toBeUndefined();
    expect(doneReported(job('failed', { finalReported: true }, { doneReported: true }))).toBeUndefined();
    expect(doneReported(undefined)).toBeUndefined();
  });

  it('partly done (issue #1892): no end label once its merged part leaves parts to run; not judged else', () => {
    expect(labelsFor({ state: 'partly_done', eventState: 'partly_done' }, { partsLeft: true })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'partly_done', eventState: 'partly_done' })).toBeUndefined();
    expect(labelDrift({ state: 'partly_done', eventState: 'partly_done' }, ['hopper', 'hopper:partly-done'], { partsLeft: true })).toEqual({ remove: ['hopper:partly-done'], add: [] });
    expect(labelTakenOff({ state: 'partly_done', eventState: 'partly_done' }, ['hopper', 'hopper:partly-done'], ['hopper'], { partsLeft: true })).toBeUndefined();
  });

  it('partly done by the last part (issue #1892 part 35): hopper:done, as the follow put it on with that merge', () => {
    const last = { state: 'partly_done', eventState: 'partly_done' } as const;
    expect(labelsFor(last, { lastPartMerged: true })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelDrift(last, ['hopper', 'hopper:partly-done'], { lastPartMerged: true })).toEqual({ remove: ['hopper:partly-done'], add: ['hopper:done'] });
    expect(labelTakenOff(last, ['hopper', 'hopper:done'], ['hopper'], { lastPartMerged: true })).toBe('hopper:done');
    expect(labelsFor({ state: 'partly_done', eventState: 'failed' }, { lastPartMerged: true })).toBeUndefined();
  });

  it('needs you (issue #1892): no end label while its job waits on a person; a hand-off is not judged', () => {
    expect(labelsFor({ state: 'needs_you', waitingOn: 'a question' })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'needs_you', waitingOn: 'a person to pick up the parked job' })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'needs_you', waitingOn: HANDOFF_WAIT })).toBeUndefined();
    expect(labelsFor({ state: 'needs_you' })).toBeUndefined();
    expect(labelDrift({ state: 'needs_you', waitingOn: 'a research report' }, ['hopper', 'hopper:claimed', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: [] });
    expect(labelTakenOff({ state: 'needs_you', waitingOn: 'a question' }, ['hopper', 'hopper:pr-ready'], ['hopper'])).toBeUndefined();
  });

  it('a hand-off (issue #1892): hopper:failed once its job\'s failure was reported as failed; not judged before', () => {
    const handoff = { state: 'needs_you', eventState: 'needs_you', waitingOn: HANDOFF_WAIT } as const;
    expect(labelsFor(handoff, { failureReported: true })).toEqual({ allowed: ['hopper:failed'], add: 'hopper:failed' });
    expect(labelsFor(handoff)).toBeUndefined();
    expect(labelDrift(handoff, ['hopper', 'hopper:pr-ready'], { failureReported: true })).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:failed'] });
    expect(labelTakenOff(handoff, ['hopper', 'hopper:failed'], ['hopper'], { failureReported: true })).toBe('hopper:failed');
  });

  it('a request card (issue #1892): no end label, and none to take off', () => {
    expect(labelsFor({ state: 'waiting_for_approval' })).toEqual({ allowed: [] });
    expect(labelDrift({ state: 'waiting_for_approval' }, ['hopper', 'hopper:done'])).toEqual({ remove: ['hopper:done'], add: [] });
    expect(labelTakenOff({ state: 'waiting_for_approval' }, ['hopper', 'hopper:done'], ['hopper'])).toBeUndefined();
  });

  it('dropped by a person\'s Won\'t do (issue #1892): hopper:rejected, and taking it off is a label edit; not judged else', () => {
    const wontDo = { state: 'dropped', eventState: 'dropped', wontDo: true } as const;
    expect(labelsFor(wontDo)).toEqual({ allowed: ['hopper:rejected'], add: 'hopper:rejected' });
    expect(labelsFor({ state: 'dropped', eventState: 'dropped' })).toBeUndefined();
    expect(labelDrift(wontDo, ['hopper', 'hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: ['hopper:rejected'] });
    expect(labelTakenOff(wontDo, ['hopper', 'hopper:rejected'], ['hopper'])).toBe('hopper:rejected');
  });

  it('dropped by a cancelled or rejected job, its report out (issue #1892 part 19): no end label; one a person put on: that one', () => {
    const cancelled = { state: 'dropped', eventState: 'dropped' } as const;
    expect(labelsFor(cancelled, { dropReported: 'none' })).toEqual({ allowed: [] });
    expect(labelDrift(cancelled, ['hopper', 'hopper:done'], { dropReported: 'none' })).toEqual({ remove: ['hopper:done'], add: [] });
    const kept = { ...cancelled, keptOut: 'hopper:done' };
    expect(labelsFor(kept, { dropReported: 'none' })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelDrift(kept, ['hopper', 'hopper:done', 'hopper:failed'], { dropReported: 'none' })).toEqual({ remove: ['hopper:failed'], add: [] });
    expect(labelTakenOff(kept, ['hopper', 'hopper:done'], ['hopper'], { dropReported: 'none' })).toBe('hopper:done');
  });

  it('dropped by a tend job cancelled not on purpose, its report out (issue #1892 part 23): hopper:pr-ready', () => {
    const tend = { state: 'dropped', eventState: 'dropped' } as const;
    expect(labelsFor(tend, { dropReported: 'pr_ready' })).toEqual({ allowed: ['hopper:pr-ready'], add: 'hopper:pr-ready' });
    expect(labelDrift(tend, ['hopper', 'hopper:failed'], { dropReported: 'pr_ready' })).toEqual({ remove: ['hopper:failed'], add: ['hopper:pr-ready'] });
    expect(labelTakenOff(tend, ['hopper', 'hopper:pr-ready'], ['hopper'], { dropReported: 'pr_ready' })).toBe('hopper:pr-ready');
    expect(labelPutOn(tend, ['hopper', 'hopper:pr-ready'], ['hopper', 'hopper:pr-ready', 'hopper:done'], { dropReported: 'pr_ready' })).toBeUndefined();
  });

  it('dropped by a dismissed failure (issue #1892 part 20): hopper:failed once the failure was reported as failed', () => {
    const dismissed = { state: 'dropped', eventState: 'dropped', dismissed: true } as const;
    expect(labelsFor(dismissed, { failureReported: true })).toEqual({ allowed: ['hopper:failed'], add: 'hopper:failed' });
    expect(labelsFor(dismissed)).toBeUndefined();
    expect(labelsFor(dismissed, { dropReported: 'none' })).toBeUndefined();
    expect(labelDrift(dismissed, ['hopper', 'hopper:pr-ready'], { failureReported: true })).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:failed'] });
    expect(labelTakenOff(dismissed, ['hopper', 'hopper:failed'], ['hopper'], { failureReported: true })).toBe('hopper:failed');
    expect(labelPutOn(dismissed, ['hopper'], ['hopper', 'hopper:done'], { failureReported: true })).toBeUndefined();
  });

  it('dropped by a person\'s Close PR (issue #1892 part 21): hopper:pr-closed, as the follow put it on', () => {
    const closed = { state: 'dropped', eventState: 'dropped', closedByPerson: true } as const;
    expect(labelsFor(closed)).toEqual({ allowed: ['hopper:pr-closed'], add: 'hopper:pr-closed' });
    expect(labelDrift(closed, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:pr-closed'] });
    expect(labelTakenOff(closed, ['hopper', 'hopper:pr-closed'], ['hopper'])).toBe('hopper:pr-closed');
    expect(labelPutOn(closed, ['hopper'], ['hopper', 'hopper:done'])).toBeUndefined();
  });

  it('dropped by the hopper\'s own close (issue #1892 part 22): hopper:pr-closed, as the follow put it on', () => {
    const closed = { state: 'dropped', eventState: 'dropped', closedByHopper: true } as const;
    expect(labelsFor(closed)).toEqual({ allowed: ['hopper:pr-closed'], add: 'hopper:pr-closed' });
    expect(labelDrift(closed, ['hopper', 'hopper:done'])).toEqual({ remove: ['hopper:done'], add: ['hopper:pr-closed'] });
    expect(labelTakenOff(closed, ['hopper', 'hopper:pr-closed'], ['hopper'])).toBe('hopper:pr-closed');
    expect(labelPutOn(closed, ['hopper'], ['hopper', 'hopper:done'])).toBeUndefined();
  });

  it('the other states are not judged', () => {
    for (const state of ['needs_you', 'partly_done', 'done', 'failed', 'dropped'] as const) expect(labelsFor({ state })).toBeUndefined();
  });
});

describe('labelDrift: what a discover saw against the state (issue #1891)', () => {
  it('#465: blocked for want of a pull request, hopper:pr-ready still on: it comes off, and no hopper:blocked goes on (issue #2693)', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: [] });
  });

  it('labels that match the state: no drift; labels that are no end labels are never judged', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'stale' }, ['hopper', 'hopper:blocked', 'hopper:high'])).toBeUndefined();
    expect(labelDrift({ state: 'pr_open' }, ['hopper', 'hopper:partly-done'])).toBeUndefined();
    expect(labelDrift({ state: 'working' }, ['hopper', 'hopper:claimed'])).toBeUndefined();
    expect(labelDrift({ state: 'done' }, ['hopper', 'hopper:pr-ready'])).toBeUndefined();
  });

  it('a job at work with an end label left on; PR open with no waiting label', () => {
    expect(labelDrift({ state: 'queued' }, ['hopper', 'hopper:done'])).toEqual({ remove: ['hopper:done'], add: [] });
    expect(labelDrift({ state: 'pr_open' }, ['hopper'])).toEqual({ remove: [], add: ['hopper:pr-ready'] });
    expect(labelDrift({ state: 'pr_open' }, ['hopper'], { part: true })).toEqual({ remove: [], add: ['hopper:partly-done'] });
  });

  it('a second close: hopper:pr-closed wanted, hopper:blocked off', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'pr_closed' }, ['hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: ['hopper:pr-closed'] });
  });
});

describe('blockLabels: the label change of a block the item reconciler makes (issue #1891, part 8)', () => {
  it('PR open blocked as stale: its waiting labels come off, hopper:blocked goes on', () => {
    expect(blockLabels('pr_open', 'stale')).toEqual({ remove: ['hopper:pr-ready', 'hopper:partly-done'], add: ['hopper:blocked'] });
    expect(blockLabels('pr_open', 'no_pr')).toEqual({ remove: ['hopper:pr-ready', 'hopper:partly-done'], add: [] });
  });

  it('partly done blocked as stale: hopper:partly-done comes off', () => {
    expect(blockLabels('partly_done', 'stale')).toEqual({ remove: ['hopper:partly-done'], add: ['hopper:blocked'] });
  });

  it('a state a job holds: nothing to take off', () => {
    for (const state of ['queued', 'working', 'waiting_outside'] as const) expect(blockLabels(state, 'stale')).toEqual({ remove: [], add: ['hopper:blocked'] });
  });
});

describe('labelTakenOff: an end label a person took off by hand (issue #1892)', () => {
  it('blocked: the blocked label seen before and gone now', () => {
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'pr_closed' }, ['hopper', 'hopper:pr-closed'], ['hopper'])).toBe('hopper:pr-closed');
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'stale' }, ['hopper', 'hopper:blocked'], ['hopper', 'hopper:high'])).toBe('hopper:blocked');
  });

  it('PR open: its waiting label gone, but not a swap of one waiting label for the other', () => {
    expect(labelTakenOff({ state: 'pr_open' }, ['hopper', 'hopper:pr-ready'], ['hopper'])).toBe('hopper:pr-ready');
    expect(labelTakenOff({ state: 'pr_open' }, ['hopper', 'hopper:pr-ready'], ['hopper', 'hopper:partly-done'])).toBeUndefined();
  });

  it('no label seen before, the label still on, or a state with no label to want: no edit', () => {
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'stale' }, ['hopper'], ['hopper'])).toBeUndefined();
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'stale' }, ['hopper', 'hopper:blocked'], ['hopper', 'hopper:blocked'])).toBeUndefined();
    expect(labelTakenOff({ state: 'working' }, ['hopper', 'hopper:done'], ['hopper'])).toBeUndefined();
    expect(labelTakenOff({ state: 'failed' }, ['hopper', 'hopper:failed'], ['hopper'])).toBeUndefined();
  });
});

describe('labelPutOn: an end label a person put on a request card by hand (issue #1892)', () => {
  it('a card: the end label not seen before and on now', () => {
    expect(labelPutOn({ state: 'waiting_for_approval' }, ['hopper'], ['hopper', 'hopper:rejected'])).toBe('hopper:rejected');
  });

  it('a label seen before, a label that is no end label, or any other state: no edit', () => {
    expect(labelPutOn({ state: 'waiting_for_approval' }, ['hopper', 'hopper:done'], ['hopper', 'hopper:done'])).toBeUndefined();
    expect(labelPutOn({ state: 'waiting_for_approval' }, ['hopper'], ['hopper', 'hopper:high'])).toBeUndefined();
    expect(labelPutOn({ state: 'queued' }, ['hopper'], ['hopper', 'hopper:done'])).toBeUndefined();
  });

  it('an item a cancelled or rejected job dropped, its report out (issue #1892 part 19): the end label put on', () => {
    const cancelled = { state: 'dropped', eventState: 'dropped' } as const;
    expect(labelPutOn(cancelled, ['hopper'], ['hopper', 'hopper:rejected'], { dropReported: 'none' })).toBe('hopper:rejected');
    expect(labelPutOn(cancelled, ['hopper'], ['hopper', 'hopper:rejected'])).toBeUndefined();
    expect(labelPutOn({ ...cancelled, keptOut: 'hopper:rejected' }, ['hopper', 'hopper:rejected'], ['hopper', 'hopper:rejected', 'hopper:done'], { dropReported: 'none' })).toBeUndefined();
    expect(labelPutOn({ ...cancelled, wontDo: true }, ['hopper'], ['hopper', 'hopper:done'], { dropReported: 'none' })).toBeUndefined();
  });
});

describe('dropReported: what a cancelled or rejected job\'s report left (issue #1892 parts 19, 23)', () => {
  const sync = (finalReported: boolean, cancelReason?: string) => ({ sync: { finalReported, ...(cancelReason ? { cancelReason } : {}) } });
  it('cancelled or rejected, reported: no end label', () => {
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBe('none');
    expect(dropReported({ status: 'rejected', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBe('none');
  });
  it('a tend job cancelled not on purpose: hopper:pr-ready; on purpose or rejected: no end label', () => {
    const tend = { executor: 'x', payload: {}, tend: true as const };
    expect(dropReported({ status: 'cancelled', spec: tend, sourceState: sync(true) })).toBe('pr_ready');
    expect(dropReported({ status: 'cancelled', spec: tend, sourceState: sync(true, DELIBERATE_CANCELS[0]) })).toBe('none');
    expect(dropReported({ status: 'rejected', spec: tend, sourceState: sync(true) })).toBe('none');
  });
  it('not reported yet, or another end: not judged', () => {
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {} }, sourceState: sync(false) })).toBeUndefined();
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {}, tend: true }, sourceState: sync(false) })).toBeUndefined();
    expect(dropReported({ status: 'failed', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBeUndefined();
    expect(dropReported(undefined)).toBeUndefined();
  });
});
