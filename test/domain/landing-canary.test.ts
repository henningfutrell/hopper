// The canary (issue #1073 part 5, design.md "Landing batches: the canary"), pure: the canary's state from its events,
// when a candidate starts, when it is held or goes to stable, and the issue a held one files.
//
// Feature: the canary
//   Scenario: a new candidate on canary starts the canary window; nothing new does nothing
//   Scenario: a bug report that names the candidate holds it
//   Scenario: the window passes with no report: the candidate goes to stable
//   Scenario: the state from the events: started, held, its issue, promoted
//   Scenario: the issue text names the candidate and the reports, and no person
import { describe, expect, it } from 'vitest';
import { canaryIssueText, canaryNext, canaryVerdict, reduceCanary, type CanaryState } from '../../src/domain/landing-canary.ts';

const TIP = '0123456789abcdef0123456789abcdef01234567';
const AT = '2026-10-14T00:00:00.000Z';
const hoursAfter = (h: number) => new Date(Date.parse(AT) + h * 3_600_000);

describe('canaryNext', () => {
  it('nothing new on canary beyond stable: idle', () => {
    expect(canaryNext(undefined, { tip: TIP, aheadBy: 0 })).toEqual({ kind: 'idle', why: 'nothing new on canary beyond stable' });
  });
  it('a new candidate starts the window', () => {
    expect(canaryNext(undefined, { tip: TIP, aheadBy: 2 })).toMatchObject({ kind: 'start' });
    expect(canaryNext({ tip: 'old', state: 'promoted', startedAt: AT, reports: [], at: AT }, { tip: TIP, aheadBy: 2 })).toMatchObject({ kind: 'start' });
  });
  it('the candidate at work is watched; a held one waits', () => {
    expect(canaryNext({ tip: TIP, state: 'running', startedAt: AT, reports: [], at: AT }, { tip: TIP, aheadBy: 2 })).toEqual({ kind: 'watch' });
    expect(canaryNext({ tip: TIP, state: 'held', startedAt: AT, reports: [7], reason: 'r', at: AT }, { tip: TIP, aheadBy: 2 }))
      .toEqual({ kind: 'idle', why: 'the canary 0123456789ab is held: r' });
  });
});

describe('canaryVerdict', () => {
  const running = { tip: TIP, state: 'running' as const, startedAt: AT, reports: [], at: AT };
  it('a bug report that names the candidate holds it', () => {
    expect(canaryVerdict(running, [41, 42], 24, hoursAfter(1))).toEqual({ kind: 'hold', reason: 'bug reports name it: #41, #42' });
  });
  it('no report and the window passed: promote', () => {
    expect(canaryVerdict(running, [], 24, hoursAfter(24))).toEqual({ kind: 'promote', why: 'no bug report named it in 24 hours' });
  });
  it('no report yet, the window still open: wait', () => {
    expect(canaryVerdict(running, [], 24, hoursAfter(20))).toEqual({ kind: 'wait', why: 'the canary 0123456789ab runs 4 more hours with no bug report' });
  });
});

describe('reduceCanary', () => {
  it('started, held with its issue, then a new candidate promoted', () => {
    const s: CanaryState = {};
    reduceCanary(s, 'landing_batch.canary_started', { tip: TIP }, AT);
    expect(s.canary).toEqual({ tip: TIP, state: 'running', startedAt: AT, reports: [], at: AT });
    reduceCanary(s, 'landing_batch.canary_held', { tip: TIP, reports: [41], reason: 'bug reports name it: #41' }, AT);
    reduceCanary(s, 'landing_batch.canary_issue_filed', { tip: TIP, issue: 50, url: 'u' }, AT);
    expect(s.canary).toMatchObject({ state: 'held', reports: [41], reason: 'bug reports name it: #41', issue: { issue: 50, url: 'u' } });
    reduceCanary(s, 'landing_batch.canary_started', { tip: 'next' }, AT);
    reduceCanary(s, 'landing_batch.canary_promoted', { tip: 'next' }, AT);
    expect(s.canary).toMatchObject({ tip: 'next', state: 'promoted' });
    expect(s.canary?.issue).toBeUndefined();
  });
  it('an event of another candidate changes nothing', () => {
    const s: CanaryState = {};
    reduceCanary(s, 'landing_batch.canary_started', { tip: TIP }, AT);
    reduceCanary(s, 'landing_batch.canary_promoted', { tip: 'other' }, AT);
    expect(s.canary?.state).toBe('running');
  });
});

describe('canaryIssueText', () => {
  it('names the candidate and the reports, and what to do; no person', () => {
    const t = canaryIssueText({ tip: TIP, reports: [41, 42], hours: 24 });
    expect(t.title).toBe('The canary 0123456789ab is held: bug reports name it');
    expect(t.body).toContain('- #41');
    expect(t.body).toContain('- #42');
    expect(t.body).toContain('bash scripts/promote.sh stable 0123456789abcdef0123456789abcdef01234567');
    expect(t.body).not.toMatch(/@/);
  });
});
