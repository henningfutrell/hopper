// The item lifecycle (issue #1891): each state not ended has an owner and a next check, each state no person holds a
// deadline, a state that waits on a pull request needs one, and the reconciler's correction is what the item broke, else nothing.
import { describe, expect, it } from 'vitest';
import { blockedStuck, checkOf, correctionOf, hasReference, RUN_AGAIN_WINDOW_MS, transitionOwner } from '../../src/domain/item-lifecycle.ts';
import { WORK_ITEM_STATES, type WorkItem } from '../../src/domain/work-items.ts';

const KEY = 'https://github.com/o/r/issues/1';
const T0 = '2026-10-13T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const item = (o: Partial<WorkItem>): WorkItem => ({ key: KEY, state: 'queued', stateSince: T0, eventState: 'queued', eventAt: T0, keptWork: [], version: 1, jobId: 'j1', ...o });
const ended = { id: 'j1', status: 'finished', ended: true, updatedAt: T0 };

describe('the item lifecycle', () => {
  it('every state not ended has an owner and a next check; each state no person holds a deadline; done and dropped have none', () => {
    for (const s of WORK_ITEM_STATES) {
      const c = checkOf(s, T0);
      if (s === 'done' || s === 'dropped') expect(c).toBeUndefined();
      else expect(c?.owner).toBeDefined();
      // A person, or the failure assessor that hands it to one, holds it as long as they like: no deadline.
      if (c?.owner === 'person' || c?.owner === 'assessor') expect(c.deadline).toBeUndefined();
      else if (c) expect(c.deadline).toBeDefined();
    }
    expect(checkOf('pr_open', T0)).toEqual({ owner: 'github_observer', nextCheckAt: at(5), deadline: at(60) });
    expect(checkOf('queued', T0, at(7))).toEqual({ owner: 'scheduler', nextCheckAt: at(12), deadline: at(60) });
    expect(checkOf('working', T0)?.deadline).toBe(at(60));
    expect(checkOf('waiting_outside', T0)?.deadline).toBe(at(60));
    expect(checkOf('partly_done', T0)?.deadline).toBe(at(24 * 60));
  });

  it('blocks an item a job holds past its deadline as stale only when no job of it is found', () => {
    const live = { id: 'j1', status: 'running', ended: false, updatedAt: T0 };
    for (const state of ['queued', 'working', 'waiting_outside'] as const) {
      const held = item({ state, eventState: state });
      // A live job holds it: its lane and its own wait have their own deadlines.
      expect(correctionOf(held, live, false, at(61))).toBeUndefined();
      // Its job ended a moment ago: folded again from its end once that settles, never blocked.
      expect(correctionOf(held, { ...ended, updatedAt: at(60) }, false, at(61))).toBeUndefined();
      // No job, or its job is gone: stale, but only past the deadline.
      expect(correctionOf(held, undefined, false, at(59))).toBeUndefined();
      expect(correctionOf(held, undefined, false, at(61))).toEqual({ kind: 'block', key: KEY, from: state, cause: 'stale' });
      expect(correctionOf({ ...held, jobId: undefined }, undefined, false, at(61))).toEqual({ kind: 'block', key: KEY, from: state, cause: 'stale' });
    }
    // Waiting outside with its job ended: folded again from that end, as queued and working are.
    expect(correctionOf(item({ state: 'waiting_outside', eventState: 'waiting_outside' }), ended, false, at(3))).toEqual({ kind: 'replay', key: KEY, jobId: 'j1', from: 'waiting_outside' });
  });

  it('blocks an item partly done a day on with no next part as stale', () => {
    const part = item({ state: 'partly_done', eventState: 'partly_done', pullRequest: 'https://github.com/o/r/pull/2', pullRequestState: 'merged' });
    expect(correctionOf(part, ended, false, at(23 * 60))).toBeUndefined();
    expect(correctionOf(part, ended, false, at(24 * 60))).toEqual({ kind: 'block', key: KEY, from: 'partly_done', cause: 'stale' });
  });

  it('never blocks an item a person or the failure assessor holds, however long it waits', () => {
    for (const state of ['waiting_for_approval', 'needs_you', 'failed'] as const) {
      expect(correctionOf(item({ state, eventState: state }), ended, false, at(30 * 24 * 60))).toBeUndefined();
      expect(correctionOf(item({ state, eventState: state, jobId: undefined }), undefined, false, at(30 * 24 * 60))).toBeUndefined();
    }
  });

  it('each move names its owner', () => {
    expect(transitionOwner('work_item.reconciled')).toBe('reconciler');
    expect(transitionOwner('job.pull_request_merged')).toBe('github_observer');
    expect(transitionOwner('job.queued')).toBe('scheduler');
    expect(transitionOwner('job.finished')).toBe('lane_worker');
    expect(transitionOwner('source.request_approved')).toBe('person');
    expect(transitionOwner('handoff.opened')).toBe('assessor');
  });

  it('PR open needs a pull request named', () => {
    expect(hasReference('pr_open', {})).toBe(false);
    expect(hasReference('pr_open', { pullRequest: 'https://github.com/o/r/pull/2' })).toBe(true);
    expect(hasReference('queued', {})).toBe(true);
  });

  it('folds an item queued or working whose newest job ended, after the grace; never one whose job lives', () => {
    expect(correctionOf(item({}), ended, false, at(1))).toBeUndefined();
    expect(correctionOf(item({}), ended, false, at(3))).toEqual({ kind: 'replay', key: KEY, jobId: 'j1', from: 'queued' });
    expect(correctionOf(item({ state: 'working' }), ended, false, at(3))?.kind).toBe('replay');
    expect(correctionOf(item({}), { ...ended, status: 'running', ended: false }, false, at(3))).toBeUndefined();
    // Another job than the item's newest: it is not the item's to fold from.
    expect(correctionOf(item({}), { ...ended, id: 'j0' }, false, at(3))).toBeUndefined();
  });

  it('folds an item blocked for want of a pull request once its finished job names one', () => {
    const blocked = item({ state: 'blocked', eventState: 'blocked', blockedCause: 'no_pr' });
    expect(correctionOf(blocked, ended, false, at(3))).toBeUndefined();
    expect(correctionOf(blocked, { ...ended, pullRequest: 'https://github.com/o/r/pull/2' }, false, at(3))).toEqual({ kind: 'replay', key: KEY, jobId: 'j1', from: 'blocked' });
    expect(correctionOf({ ...blocked, blockedCause: 'stale' }, { ...ended, pullRequest: 'https://github.com/o/r/pull/2' }, false, at(3))).toMatchObject({ kind: 'ask', cause: 'stale' });
  });

  it('runs an item again by itself only on the first close of its pull request in a row, within the window; Failures lists the others', () => {
    const PR = 'https://github.com/o/r/pull/2';
    const closed = item({ state: 'blocked', eventState: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 1, pullRequest: PR, pullRequestState: 'closed' });
    expect(correctionOf(closed, ended, false, at(1))).toBeUndefined();
    expect(correctionOf(closed, ended, false, at(3))).toEqual({ kind: 'run_again', key: KEY, jobId: 'j1', cause: 'pr_closed', pullRequest: PR });
    expect(blockedStuck(closed, at(3))).toBe(false);
    // A second close in a row, or one older than the window (a rebuild found it): a person decides.
    expect(correctionOf({ ...closed, closedWithoutMerge: 2 }, ended, false, at(3))).toMatchObject({ kind: 'ask', cause: 'pr_closed' });
    expect(blockedStuck({ ...closed, closedWithoutMerge: 2 }, at(3))).toBe(true);
    const late = new Date(Date.parse(T0) + RUN_AGAIN_WINDOW_MS).toISOString();
    expect(correctionOf(closed, ended, false, late)).toMatchObject({ kind: 'ask', cause: 'pr_closed' });
    expect(blockedStuck(closed, late)).toBe(true);
    // Not the item's newest job, or a job still at work: nothing.
    expect(correctionOf(closed, { ...ended, id: 'j0' }, false, at(3))).toBeUndefined();
    expect(correctionOf(closed, { ...ended, status: 'running', ended: false }, false, at(3))).toBeUndefined();
  });

  it('blocks an item in PR open past its deadline: no_pr with none named, stale with one no job follows', () => {
    const open = item({ state: 'pr_open', eventState: 'pr_open', pullRequest: 'https://github.com/o/r/pull/2', pullRequestState: 'open' });
    expect(correctionOf(open, ended, false, at(59))).toBeUndefined();
    expect(correctionOf(open, ended, true, at(61))).toBeUndefined();
    expect(correctionOf(open, ended, false, at(61))).toEqual({ kind: 'block', key: KEY, from: 'pr_open', cause: 'stale' });
    expect(correctionOf(item({ state: 'pr_open', eventState: 'pr_open' }), ended, true, at(61))).toEqual({ kind: 'block', key: KEY, from: 'pr_open', cause: 'no_pr' });
  });

  it('asks a person once about a blocked item that is stuck work; never one it runs again by itself, nor one asked already', () => {
    const PR = 'https://github.com/o/r/pull/2';
    const stale = item({ state: 'blocked', eventState: 'blocked', blockedCause: 'stale', pullRequest: PR });
    expect(correctionOf(stale, ended, false, at(1))).toBeUndefined();
    expect(correctionOf(stale, ended, false, at(3))).toEqual({ kind: 'ask', key: KEY, cause: 'stale', jobId: 'j1', pullRequest: PR });
    expect(correctionOf({ ...stale, personAsked: true }, ended, false, at(3))).toBeUndefined();
    // For want of a pull request: only once it ran again by itself as often as it may (issue #2693), and Failures lists it.
    const noPr = item({ state: 'blocked', eventState: 'blocked', blockedCause: 'no_pr', noPullRequestEnds: 3 });
    expect(correctionOf(noPr, ended, false, at(5))).toBeUndefined();
    expect(correctionOf(noPr, ended, false, at(10))).toEqual({ kind: 'ask', key: KEY, cause: 'no_pr', jobId: 'j1' });
    // Closed once: the reconciler runs it again, no person is asked. Closed twice: a person is asked.
    const closed = item({ state: 'blocked', eventState: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 1, pullRequest: PR });
    expect(correctionOf(closed, { ...ended, status: 'running', ended: false }, false, at(3))).toBeUndefined();
    expect(correctionOf({ ...closed, closedWithoutMerge: 2 }, ended, false, at(3))).toEqual({ kind: 'ask', key: KEY, cause: 'pr_closed', jobId: 'j1', pullRequest: PR });
  });
});
