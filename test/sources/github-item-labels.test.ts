// Labels mirror the database (issues #1891, #1933): the end labels an issue should carry are a pure function of its work item's
// state, and a drift is what a discover saw against them.
import { describe, expect, it } from 'vitest';
import { HANDOFF_WAIT } from '../../src/domain/work-items.ts';
import { blockLabels, dropReported, labelDrift, labelPutOn, labelsFor, labelTakenOff } from '../../src/sources/github/item-labels.ts';

describe('labelsFor: the end labels a state wants (issue #1891)', () => {
  it('a job at work: no end label', () => {
    for (const state of ['queued', 'working', 'waiting_outside'] as const) expect(labelsFor({ state })).toEqual({ allowed: [] });
  });

  it('PR open: its waiting label, of a whole pull request or of a part', () => {
    expect(labelsFor({ state: 'pr_open' })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:pr-ready' });
    expect(labelsFor({ state: 'pr_open' }, { part: true })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'], add: 'hopper:partly-done' });
  });

  it('blocked: hopper:blocked, or hopper:pr-closed when its pull request was closed without a merge', () => {
    expect(labelsFor({ state: 'blocked', blockedCause: 'no_pr' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
    expect(labelsFor({ state: 'blocked', blockedCause: 'stale' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
    expect(labelsFor({ state: 'blocked', blockedCause: 'pr_closed' })).toEqual({ allowed: ['hopper:pr-closed'], add: 'hopper:pr-closed' });
  });

  it('failed (issue #1892): hopper:failed once its job\'s failure was reported as failed; not judged before, nor a reverted culprit', () => {
    expect(labelsFor({ state: 'failed', eventState: 'failed' }, { failureReported: true })).toEqual({ allowed: ['hopper:failed'], add: 'hopper:failed' });
    expect(labelsFor({ state: 'failed', eventState: 'failed' })).toBeUndefined();
    expect(labelsFor({ state: 'failed', eventState: 'done' }, { failureReported: true })).toBeUndefined();
    expect(labelTakenOff({ state: 'failed', eventState: 'failed' }, ['hopper', 'hopper:failed'], ['hopper'], { failureReported: true })).toBe('hopper:failed');
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

  it('partly done (issue #1892): no end label once its merged part leaves parts to run; not judged else', () => {
    expect(labelsFor({ state: 'partly_done', eventState: 'partly_done' }, { partsLeft: true })).toEqual({ allowed: [] });
    expect(labelsFor({ state: 'partly_done', eventState: 'partly_done' })).toBeUndefined();
    expect(labelDrift({ state: 'partly_done', eventState: 'partly_done' }, ['hopper', 'hopper:partly-done'], { partsLeft: true })).toEqual({ remove: ['hopper:partly-done'], add: [] });
    expect(labelTakenOff({ state: 'partly_done', eventState: 'partly_done' }, ['hopper', 'hopper:partly-done'], ['hopper'], { partsLeft: true })).toBeUndefined();
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
    expect(labelsFor(cancelled, { dropReported: true })).toEqual({ allowed: [] });
    expect(labelDrift(cancelled, ['hopper', 'hopper:done'], { dropReported: true })).toEqual({ remove: ['hopper:done'], add: [] });
    const kept = { ...cancelled, keptOut: 'hopper:done' };
    expect(labelsFor(kept, { dropReported: true })).toEqual({ allowed: ['hopper:done'], add: 'hopper:done' });
    expect(labelDrift(kept, ['hopper', 'hopper:done', 'hopper:failed'], { dropReported: true })).toEqual({ remove: ['hopper:failed'], add: [] });
    expect(labelTakenOff(kept, ['hopper', 'hopper:done'], ['hopper'], { dropReported: true })).toBe('hopper:done');
  });

  it('dropped by a dismissed failure (issue #1892 part 20): hopper:failed once the failure was reported as failed', () => {
    const dismissed = { state: 'dropped', eventState: 'dropped', dismissed: true } as const;
    expect(labelsFor(dismissed, { failureReported: true })).toEqual({ allowed: ['hopper:failed'], add: 'hopper:failed' });
    expect(labelsFor(dismissed)).toBeUndefined();
    expect(labelsFor(dismissed, { dropReported: true })).toBeUndefined();
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

  it('the other states are not judged', () => {
    for (const state of ['needs_you', 'partly_done', 'done', 'failed', 'dropped'] as const) expect(labelsFor({ state })).toBeUndefined();
  });
});

describe('labelDrift: what a discover saw against the state (issue #1891)', () => {
  it('#465: blocked for want of a pull request, hopper:pr-ready still on: it comes off, hopper:blocked goes on', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:blocked'] });
  });

  it('labels that match the state: no drift; labels that are no end labels are never judged', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:blocked', 'hopper:high'])).toBeUndefined();
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
    expect(blockLabels('pr_open', 'no_pr')).toEqual({ remove: ['hopper:pr-ready', 'hopper:partly-done'], add: ['hopper:blocked'] });
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
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:blocked'], ['hopper', 'hopper:high'])).toBe('hopper:blocked');
  });

  it('PR open: its waiting label gone, but not a swap of one waiting label for the other', () => {
    expect(labelTakenOff({ state: 'pr_open' }, ['hopper', 'hopper:pr-ready'], ['hopper'])).toBe('hopper:pr-ready');
    expect(labelTakenOff({ state: 'pr_open' }, ['hopper', 'hopper:pr-ready'], ['hopper', 'hopper:partly-done'])).toBeUndefined();
  });

  it('no label seen before, the label still on, or a state with no label to want: no edit', () => {
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper'], ['hopper'])).toBeUndefined();
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:blocked'], ['hopper', 'hopper:blocked'])).toBeUndefined();
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
    expect(labelPutOn(cancelled, ['hopper'], ['hopper', 'hopper:rejected'], { dropReported: true })).toBe('hopper:rejected');
    expect(labelPutOn(cancelled, ['hopper'], ['hopper', 'hopper:rejected'])).toBeUndefined();
    expect(labelPutOn({ ...cancelled, keptOut: 'hopper:rejected' }, ['hopper', 'hopper:rejected'], ['hopper', 'hopper:rejected', 'hopper:done'], { dropReported: true })).toBeUndefined();
    expect(labelPutOn({ ...cancelled, wontDo: true }, ['hopper'], ['hopper', 'hopper:done'], { dropReported: true })).toBeUndefined();
  });
});

describe('dropReported: a cancelled or rejected job whose report went out (issue #1892 part 19)', () => {
  const sync = (finalReported: boolean) => ({ sync: { finalReported } });
  it('cancelled or rejected, reported: yes', () => {
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBe(true);
    expect(dropReported({ status: 'rejected', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBe(true);
  });
  it('not reported yet, a tend job, or another end: no', () => {
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {} }, sourceState: sync(false) })).toBe(false);
    expect(dropReported({ status: 'cancelled', spec: { executor: 'x', payload: {}, tend: true }, sourceState: sync(true) })).toBe(false);
    expect(dropReported({ status: 'failed', spec: { executor: 'x', payload: {} }, sourceState: sync(true) })).toBe(false);
    expect(dropReported(undefined)).toBe(false);
  });
});
