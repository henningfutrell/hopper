// No pull request found is no resting state (issue #2693): an item whose job ended with no pull request to wait on is
// blocked for want of one only while the hopper looks for it and runs it again, and its issue gets no `hopper:blocked`.
// The label mirror takes one an earlier rule put on off; Intake says why it waits, and a done item its report found with no
// pull request keeps out as done, not taken again.
import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { DONE_OPEN, NO_PR, ledgerReason } from '../../src/sources/github/discover.ts';
import { blockLabels, labelDrift, labelsFor, labelTakenOff, reportLabels } from '../../src/sources/github/item-labels.ts';

const item = (w: Partial<WorkItem>): WorkItem => ({ key: 'https://github.com/o/r/issues/1', stateSince: '', eventAt: '', keptWork: [], version: 1, state: 'blocked', eventState: 'blocked', ...w });

describe('no pull request found: no hopper:blocked (issue #2693)', () => {
  it('blocked for want of a pull request wants no end label, and the mirror takes hopper:blocked off', () => {
    expect(labelsFor({ state: 'blocked', blockedCause: 'no_pr' })).toEqual({ allowed: [] });
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:claimed', 'hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: [] });
    expect(labelTakenOff({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:blocked'], ['hopper'])).toBeUndefined();
    // A block past its deadline still waits on a person, with its label.
    expect(labelsFor({ state: 'blocked', blockedCause: 'stale' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
  });

  it('a report that found no pull request puts no label on, and takes the end labels off', () => {
    expect(reportLabels({ end: 'no_pr' })).toEqual({ remove: [], add: [] });
    expect(reportLabels({ end: 'no_pr' }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: [] });
  });

  it('the reconciler\'s block for want of a pull request takes PR open\'s labels off and puts none on', () => {
    expect(blockLabels('pr_open', 'no_pr')).toEqual({ remove: ['hopper:pr-ready', 'hopper:partly-done'], add: [] });
    expect(blockLabels('pr_open', 'stale')).toEqual({ remove: ['hopper:pr-ready', 'hopper:partly-done'], add: ['hopper:blocked'] });
  });

  it('Intake says the hopper looks for its pull request, then runs it again; a done item found with none keeps out as done', () => {
    expect(ledgerReason(item({ blockedCause: 'no_pr' }), {})).toEqual({ reason: NO_PR });
    expect(NO_PR).not.toContain('hopper:blocked');
    const done = item({ state: 'done', eventState: 'done' });
    expect(labelsFor(done, { doneReported: 'no_pr' })).toEqual({ allowed: [] });
    expect(ledgerReason(done, { doneReported: 'no_pr' })).toEqual({ reason: DONE_OPEN });
  });
});
