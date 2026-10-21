// Issue #1694: a job's own wait gets a wait check — what the hopper can test of it without a model, when it tests it next,
// and when the wait is overdue. Pure.
import { describe, expect, it } from 'vitest';
import type { Job, JobWait } from '../../src/domain/types.ts';
import {
  afterCheck, checkAskOf, checksOutcome, commandOutcome, conditionKey, conditionOf, newCheck, recheckOutcome, reviewOutcome, type WaitedChecks, type WaitedReviews, COMMAND_DEADLINE_MS, DEADLINE_MS, FIRST_CHECK_MS, MAX_EVERY_MS, OVERDUE_EVERY_MS,
} from '../../src/domain/wait-checks.ts';

const SINCE = '2026-10-17T10:00:00.000Z';
const at = (ms: number) => Date.parse(SINCE) + ms;
const waiting = (wait: Partial<JobWait>): Job => ({
  id: 'j1', spec: { executor: 'x', payload: {} }, priority: 50, status: 'waiting_on', approved: true, createdAt: SINCE, updatedAt: SINCE, attempts: 1,
  source: { source: 's', kind: 'github', key: 'https://github.com/octo/tools/issues/7', repo: 'octo/tools', number: 7 },
  wait: { for: 'it', since: SINCE, ...wait },
});

describe('what a wait check tests (conditionOf)', () => {
  it('a pull request of the job\'s own repository: its end, read as an item', () => {
    expect(conditionOf(waiting({ on: { kind: 'pull_request', number: 8, about: 'merge' } }))).toEqual({ kind: 'items_ended', refs: [{ kind: 'issue', repo: 'octo/tools', number: 8 }] });
  });

  it('a pull request\'s review: tested as its reviews, not only its end (part 3)', () => {
    expect(conditionOf(waiting({ on: { kind: 'pull_request', repo: 'octo/web', number: 3, about: 'review' } }))).toEqual({ kind: 'pr_review_ended', repo: 'octo/web', number: 3 });
    expect(conditionKey({ kind: 'pr_review_ended', repo: 'Octo/Web', number: 3 })).toBe('pr_review_ended:octo/web#3');
  });

  it('an item, and an outside event that names items and runs', () => {
    expect(conditionOf(waiting({ on: { kind: 'item', number: 9 } }))).toEqual({ kind: 'items_ended', refs: [{ kind: 'issue', repo: 'octo/tools', number: 9 }] });
    const outside = waiting({ for: 'the deploy of octo/platform run 37998997248', on: { kind: 'outside', what: 'octo/identity#199 to close' } });
    expect(conditionOf(outside)).toEqual({ kind: 'items_ended', refs: [{ kind: 'run', repo: 'octo/platform', runId: 37998997248 }, { kind: 'issue', repo: 'octo/identity', number: 199 }] });
  });

  it('a job, a question, its own command; none for an approval, a grant or an outside event it watches nothing of: a person ends it (issue #2338)', () => {
    expect(conditionOf(waiting({ on: { kind: 'job', jobId: 'j9' } }))).toEqual({ kind: 'job_ended', jobId: 'j9' });
    expect(conditionOf(waiting({ on: { kind: 'question', questionId: 'q1' } }))).toEqual({ kind: 'question_settled', questionId: 'q1' });
    expect(conditionOf(waiting({ on: { kind: 'own_command' }, ownCommand: true }))).toEqual({ kind: 'command_exited' });
    expect(conditionOf(waiting({ ownCommand: true }))).toEqual({ kind: 'command_exited' });
    expect(conditionOf(waiting({ on: { kind: 'grant' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'approval', of: 'sandbox' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'outside', what: 'write access to the repository' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'outside', what: 'the apply', why: 'gated' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'outside', what: 'the release', why: 'not_managed' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({}))).toEqual({ kind: 'none' });
  });

  it('the key names the condition, the same for the same items in any order', () => {
    const a = conditionOf(waiting({ for: 'octo/a#1 and octo/b#2', on: { kind: 'outside', what: 'x' } }));
    const b = conditionOf(waiting({ for: 'octo/b#2 and octo/a#1', on: { kind: 'outside', what: 'x' } }));
    expect(conditionKey(a)).toBe(conditionKey(b));
    expect(conditionKey({ kind: 'job_ended', jobId: 'j9' })).toBe('job_ended:j9');
  });
});

describe('when a wait check runs (newCheck, afterCheck)', () => {
  it('a new check runs a minute after the wait began, with a deadline a day after; its own command four hours after', () => {
    const c = newCheck(waiting({ on: { kind: 'item', number: 9 } }), at(5_000));
    expect(c).toMatchObject({ nextCheckAt: new Date(at(FIRST_CHECK_MS)).toISOString(), everyMs: FIRST_CHECK_MS, attempts: 0, deadline: new Date(at(DEADLINE_MS)).toISOString() });
    expect(newCheck(waiting({ ownCommand: true }), at(0)).deadline).toBe(new Date(at(COMMAND_DEADLINE_MS)).toISOString());
  });

  it('a wait the hopper flagged stuck before is checked at once', () => {
    expect(newCheck(waiting({ ownCommand: true, stuckAt: SINCE }), at(9_000)).nextCheckAt).toBe(new Date(at(9_000)).toISOString());
  });

  it('a check not met is tried again later, the time between doubling to at most half an hour', () => {
    let c = newCheck(waiting({ on: { kind: 'item', number: 9 } }), at(0));
    const gaps: number[] = [];
    let now = at(FIRST_CHECK_MS);
    for (let i = 0; i < 8; i++) {
      const next = afterCheck(c, 'still open', now);
      expect(next.overdue).toBe(false);
      gaps.push(Date.parse(next.check.nextCheckAt) - now);
      c = next.check;
      now = Date.parse(c.nextCheckAt);
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
    expect(c).toMatchObject({ attempts: 8, result: 'still open' });
    expect(MAX_EVERY_MS).toBe(30 * 60_000);
  });

  it('past its deadline: overdue once, then checked each hour', () => {
    const c = newCheck(waiting({ on: { kind: 'item', number: 9 } }), at(0));
    const first = afterCheck(c, 'still open', at(DEADLINE_MS));
    expect(first.overdue).toBe(true);
    expect(first.check.overdueAt).toBe(new Date(at(DEADLINE_MS)).toISOString());
    expect(Date.parse(first.check.nextCheckAt) - at(DEADLINE_MS)).toBe(OVERDUE_EVERY_MS);
    const second = afterCheck(first.check, 'still open', at(DEADLINE_MS + OVERDUE_EVERY_MS));
    expect(second.overdue).toBe(false);
    expect(second.check.overdueAt).toBe(first.check.overdueAt);
  });
});

describe('a wait on its own command (commandOutcome)', () => {
  const GRACE = 5 * 60_000;
  const own = (w: Partial<JobWait> = {}) => waiting({ ownCommand: true, on: { kind: 'own_command' }, ...w }).wait!;

  it('its command runs: not met; four hours after the wait began: met, the job told to look at it', () => {
    expect(commandOutcome(own(), { runs: true, lost: false }, at(60_000), GRACE)).toEqual({ met: false, result: 'its command runs' });
    const late = commandOutcome(own(), { runs: true, lost: false }, at(COMMAND_DEADLINE_MS), GRACE);
    expect(late).toMatchObject({ met: true });
    expect(late.met && late.note).toContain('4 hours');
  });

  it('its command gone: met once the grace after its nudge passed, never left stuck', () => {
    expect(commandOutcome(own(), { runs: false, lost: false }, at(60_000), GRACE)).toMatchObject({ met: false });
    expect(commandOutcome(own({ nudgedAt: new Date(at(60_000)).toISOString() }), { runs: false, lost: false }, at(120_000), GRACE)).toMatchObject({ met: false });
    expect(commandOutcome(own({ nudgedAt: new Date(at(60_000)).toISOString() }), { runs: false, lost: false }, at(60_000 + GRACE), GRACE)).toMatchObject({ met: true });
    expect(commandOutcome(own({ stuckAt: SINCE }), { runs: false, lost: false }, at(1), GRACE)).toMatchObject({ met: true });
  });

  it('its pane lost: met; its pane not read: not met', () => {
    expect(commandOutcome(own(), { runs: false, lost: true }, at(1), GRACE)).toMatchObject({ met: true });
    expect(commandOutcome(own(), { runs: null, lost: null }, at(COMMAND_DEADLINE_MS), GRACE)).toEqual({ met: false, result: 'the hopper cannot read its pane now' });
  });
});

// Part 2: the job names its check (a `check:` line after HOPPER_WAITING), a time the hopper wakes it at, and a pull request's checks.
describe('the check a job names (checkAskOf, issue #1694 part 2)', () => {
  it('in, every: the next check-in; after, at: a time to wake at; anything else: none', () => {
    expect(checkAskOf('in 20m', at(0))).toEqual({ inMs: 20 * 60_000 });
    expect(checkAskOf('every 2 minutes', at(0))).toEqual({ inMs: 2 * 60_000 });
    expect(checkAskOf('In 10 min', at(0))).toEqual({ inMs: 10 * 60_000 });
    expect(checkAskOf('after 2h', at(0))).toEqual({ at: new Date(at(2 * 3600_000)).toISOString() });
    expect(checkAskOf('at 2026-10-17T16:30:00Z', at(0))).toEqual({ at: '2026-10-17T16:30:00.000Z' });
    expect(checkAskOf('when it is done', at(0))).toBeUndefined();
    expect(checkAskOf('at noon', at(0))).toBeUndefined();
    expect(checkAskOf('in 0m', at(0))).toBeUndefined();
  });

  it('a check-in is kept between a minute and its cap; a time to wake at is never before the wait and at most a week after', () => {
    expect(checkAskOf('in 10s', at(0))).toEqual({ inMs: FIRST_CHECK_MS });
    expect(checkAskOf('in 3h', at(0))).toEqual({ inMs: MAX_EVERY_MS });
    expect(checkAskOf('at 2026-10-17T09:00:00Z', at(0))).toEqual({ at: SINCE });
    expect(checkAskOf('after 30d', at(0))).toEqual({ at: new Date(at(7 * 24 * 3600_000)).toISOString() });
  });

  it('a wait the hopper cannot test, with a time: time_passed; with a condition, the condition, woken at the time too', () => {
    const outside = waiting({ on: { kind: 'outside', what: 'a deploy window' }, checkLine: 'after 2h' });
    const wake = new Date(at(2 * 3600_000)).toISOString();
    expect(conditionOf(outside)).toEqual({ kind: 'time_passed', at: wake });
    expect(newCheck(outside, at(0))).toMatchObject({ condition: { kind: 'time_passed', at: wake }, nextCheckAt: wake });
    const item = newCheck(waiting({ on: { kind: 'item', number: 9 }, checkLine: 'after 2h' }), at(0));
    expect(item).toMatchObject({ condition: { kind: 'items_ended' }, wakeAt: wake, nextCheckAt: new Date(at(FIRST_CHECK_MS)).toISOString() });
    expect(conditionKey({ kind: 'time_passed', at: wake })).toBe(`time_passed:${wake}`);
  });

  it('a recheck (issues #2335, #2338): only at the check-in the job named; met at it, and the job is told to look again', () => {
    const outside = waiting({ on: { kind: 'outside', what: 'the deploy to finish' }, checkLine: 'in 30m' });
    const at30 = new Date(at(30 * 60_000)).toISOString();
    expect(newCheck(outside, at(0))).toMatchObject({ condition: { kind: 'recheck', at: at30 }, nextCheckAt: at30 });
    const asked = waiting({ on: { kind: 'outside', what: 'the apply', why: 'gated' }, checkLine: 'in 10m' });
    expect(newCheck(asked, at(0))).toMatchObject({ condition: { kind: 'recheck', at: new Date(at(10 * 60_000)).toISOString() } });
    expect(newCheck(waiting({ on: { kind: 'outside', what: 'the apply', why: 'gated' } }), at(0)).condition).toEqual({ kind: 'none' });
    expect(conditionKey({ kind: 'recheck', at: at30 })).toBe(`recheck:${at30}`);
    // A check before its time, as after a restart, finds it not met and tries at its time.
    const early = afterCheck(newCheck(outside, at(0)), 'it rechecks at its time', at(60_000));
    expect(early.check.nextCheckAt).toBe(at30);
    expect(recheckOutcome({ kind: 'recheck', at: at30 }, outside.wait!, at(60_000))).toEqual({ met: false, result: `it looks again at ${at30}` });
    const met = recheckOutcome({ kind: 'recheck', at: at30 }, outside.wait!, at(30 * 60_000));
    expect(met).toMatchObject({ met: true });
    expect(met.met && met.told).toContain('cannot see what you wait on (the deploy to finish)');
    expect(met.met && met.told).toContain('HOPPER_WAITING');
  });

  it('a check-in sets the first check and the time between checks', () => {
    const c = newCheck(waiting({ on: { kind: 'item', number: 9 }, checkLine: 'in 20m' }), at(0));
    expect(c).toMatchObject({ nextCheckAt: new Date(at(20 * 60_000)).toISOString(), everyMs: 20 * 60_000 });
  });

  it('a time to wake at is never passed by the backoff, and moves the deadline past it', () => {
    const c = newCheck(waiting({ on: { kind: 'item', number: 9 }, checkLine: 'after 40h' }), at(0));
    expect(Date.parse(c.deadline)).toBeGreaterThan(at(40 * 3600_000));
    const near = newCheck(waiting({ on: { kind: 'item', number: 9 }, checkLine: 'after 3m' }), at(0));
    const next = afterCheck(near, 'still open', at(2 * 60_000));
    expect(next.check.nextCheckAt).toBe(new Date(at(3 * 60_000)).toISOString());
  });

  it('a pull request\'s checks: tested as its checks, not only its end', () => {
    expect(conditionOf(waiting({ on: { kind: 'pull_request', number: 8, about: 'checks' } }))).toEqual({ kind: 'pr_checks_ended', repo: 'octo/tools', number: 8 });
    expect(conditionKey({ kind: 'pr_checks_ended', repo: 'Octo/Tools', number: 8 })).toBe('pr_checks_ended:octo/tools#8');
  });
});

describe('what a pull request\'s checks say (checksOutcome)', () => {
  const URL = 'https://github.com/octo/tools/pull/8';
  const pr = (o: Partial<WaitedChecks>): WaitedChecks => ({ url: URL, state: 'open', headCommittedAt: SINCE, ...o });
  it('passed or failed: met; running or not read: not met', () => {
    expect(checksOutcome(pr({ checks: 'passing' }), at(0))).toEqual({ met: true, note: `the checks of ${URL} passed` });
    expect(checksOutcome(pr({ checks: 'failing' }), at(0))).toEqual({ met: true, note: `the checks of ${URL} failed` });
    expect(checksOutcome(pr({ checks: 'pending' }), at(0))).toEqual({ met: false, result: `the checks of ${URL} run` });
    expect(checksOutcome(pr({ checks: 'unknown' }), at(0))).toEqual({ met: false, result: `the hopper cannot read the checks of ${URL}` });
  });

  it('merged, closed or not found: met; none started two minutes after its last push: met', () => {
    expect(checksOutcome(pr({ state: 'merged' }), at(0))).toEqual({ met: true, note: `${URL} was merged` });
    expect(checksOutcome(pr({ state: 'not_found' }), at(0))).toMatchObject({ met: true });
    expect(checksOutcome(pr({}), at(60_000))).toEqual({ met: false, result: `no checks of ${URL} started yet` });
    expect(checksOutcome(pr({}), at(2 * 60_000))).toEqual({ met: true, note: `${URL} has no checks` });
  });
});

describe('what a pull request\'s reviews say (reviewOutcome, part 3)', () => {
  const URL = 'https://github.com/octo/tools/pull/8';
  const pr = (o: Partial<WaitedReviews>): WaitedReviews => ({ url: URL, state: 'open', reviews: [], ...o });
  const since = Date.parse(SINCE);
  it('a review sent after the wait began: met, with what it says; the newest one counts', () => {
    expect(reviewOutcome(pr({ reviews: [{ state: 'approved', submittedAt: '2026-10-17T10:05:00Z' }] }), since)).toEqual({ met: true, note: `${URL} was approved` });
    expect(reviewOutcome(pr({ reviews: [{ state: 'commented', submittedAt: '2026-10-17T10:05:00Z' }, { state: 'changes_requested', submittedAt: '2026-10-17T10:06:00Z' }] }), since))
      .toEqual({ met: true, note: `${URL} got a review that asks for changes` });
    expect(reviewOutcome(pr({ reviews: [{ state: 'commented', submittedAt: '2026-10-17T10:05:00Z' }] }), since)).toEqual({ met: true, note: `${URL} got a review with comments` });
  });

  it('only reviews from before the wait, or none: not met; the reviews not read: not met', () => {
    expect(reviewOutcome(pr({ reviews: [{ state: 'changes_requested', submittedAt: '2026-10-17T09:00:00Z' }] }), since)).toEqual({ met: false, result: `no review of ${URL} since the wait began` });
    expect(reviewOutcome(pr({ reviews: [{ state: 'approved' }] }), since)).toEqual({ met: false, result: `no review of ${URL} since the wait began` });
    expect(reviewOutcome(pr({ reviews: undefined }), since)).toEqual({ met: false, result: `the hopper cannot read the reviews of ${URL}` });
  });

  it('merged, closed or not found: met', () => {
    expect(reviewOutcome(pr({ state: 'merged' }), since)).toEqual({ met: true, note: `${URL} was merged` });
    expect(reviewOutcome(pr({ state: 'closed' }), since)).toEqual({ met: true, note: `${URL} was closed` });
    expect(reviewOutcome(pr({ state: 'not_found' }), since)).toMatchObject({ met: true });
  });
});
