// Labels mirror the database (issue #1891): the end labels an issue should carry are a pure function of its work item's
// state, and a drift is what a discover saw against them.
import { describe, expect, it } from 'vitest';
import { labelDrift, labelsFor } from '../../src/sources/github/item-labels.ts';

describe('labelsFor: the end labels a state wants (issue #1891)', () => {
  it('a job at work: no end label', () => {
    for (const state of ['queued', 'working', 'waiting_outside'] as const) expect(labelsFor({ state })).toEqual({ allowed: [] });
  });

  it('PR open: its waiting label, of a whole pull request or of a part', () => {
    expect(labelsFor({ state: 'pr_open' })).toEqual({ allowed: ['hopper:pr-ready', 'hopper:partly-done'] });
  });

  it('blocked: hopper:blocked, or hopper:pr-closed when its pull request was closed without a merge', () => {
    expect(labelsFor({ state: 'blocked', blockedCause: 'no_pr' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
    expect(labelsFor({ state: 'blocked', blockedCause: 'stale' })).toEqual({ allowed: ['hopper:blocked'], add: 'hopper:blocked' });
    expect(labelsFor({ state: 'blocked', blockedCause: 'pr_closed' })).toEqual({ allowed: ['hopper:pr-closed'], add: 'hopper:pr-closed' });
  });

  it('the other states are not judged', () => {
    for (const state of ['waiting_for_approval', 'needs_you', 'partly_done', 'done', 'failed', 'dropped'] as const) expect(labelsFor({ state })).toBeUndefined();
  });
});

describe('labelDrift: what a discover saw against the state (issue #1891)', () => {
  it('#465: blocked for want of a pull request, hopper:pr-ready still on: it comes off, hopper:blocked goes on', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:pr-ready'])).toEqual({ remove: ['hopper:pr-ready'], add: ['hopper:blocked'], missing: true });
  });

  it('labels that match the state: no drift; labels that are no end labels are never judged', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'no_pr' }, ['hopper', 'hopper:blocked', 'hopper:high'])).toBeUndefined();
    expect(labelDrift({ state: 'pr_open' }, ['hopper', 'hopper:partly-done'])).toBeUndefined();
    expect(labelDrift({ state: 'working' }, ['hopper', 'hopper:claimed'])).toBeUndefined();
    expect(labelDrift({ state: 'done' }, ['hopper', 'hopper:pr-ready'])).toBeUndefined();
  });

  it('a job at work with an end label left on; PR open with no waiting label', () => {
    expect(labelDrift({ state: 'queued' }, ['hopper', 'hopper:done'])).toEqual({ remove: ['hopper:done'], add: [], missing: false });
    expect(labelDrift({ state: 'pr_open' }, ['hopper'])).toEqual({ remove: [], add: [], missing: true });
  });

  it('a second close: hopper:pr-closed wanted, hopper:blocked off', () => {
    expect(labelDrift({ state: 'blocked', blockedCause: 'pr_closed' }, ['hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: ['hopper:pr-closed'], missing: true });
  });
});
