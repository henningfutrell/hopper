// Issue #1694: a job's own wait gets a wait check — what the hopper can test of it without a model, when it tests it next,
// and when the wait is overdue. Pure.
import { describe, expect, it } from 'vitest';
import type { Job, JobWait } from '../../src/domain/types.ts';
import {
  afterCheck, commandOutcome, conditionKey, conditionOf, newCheck, COMMAND_DEADLINE_MS, DEADLINE_MS, FIRST_CHECK_MS, MAX_EVERY_MS, OVERDUE_EVERY_MS,
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
    expect(conditionOf(waiting({ on: { kind: 'pull_request', repo: 'octo/web', number: 3, about: 'checks' } }))).toEqual({ kind: 'items_ended', refs: [{ kind: 'issue', repo: 'octo/web', number: 3 }] });
  });

  it('an item, and an outside event that names items and runs', () => {
    expect(conditionOf(waiting({ on: { kind: 'item', number: 9 } }))).toEqual({ kind: 'items_ended', refs: [{ kind: 'issue', repo: 'octo/tools', number: 9 }] });
    const outside = waiting({ for: 'the deploy of octo/platform run 37998997248', on: { kind: 'outside', what: 'octo/identity#199 to close' } });
    expect(conditionOf(outside)).toEqual({ kind: 'items_ended', refs: [{ kind: 'run', repo: 'octo/platform', runId: 37998997248 }, { kind: 'issue', repo: 'octo/identity', number: 199 }] });
  });

  it('a job, a question, its own command; and none for what the hopper cannot test', () => {
    expect(conditionOf(waiting({ on: { kind: 'job', jobId: 'j9' } }))).toEqual({ kind: 'job_ended', jobId: 'j9' });
    expect(conditionOf(waiting({ on: { kind: 'question', questionId: 'q1' } }))).toEqual({ kind: 'question_settled', questionId: 'q1' });
    expect(conditionOf(waiting({ on: { kind: 'own_command' }, ownCommand: true }))).toEqual({ kind: 'command_exited' });
    expect(conditionOf(waiting({ ownCommand: true }))).toEqual({ kind: 'command_exited' });
    expect(conditionOf(waiting({ on: { kind: 'grant' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'approval', of: 'sandbox' } }))).toEqual({ kind: 'none' });
    expect(conditionOf(waiting({ on: { kind: 'outside', what: 'write access to the repository' } }))).toEqual({ kind: 'none' });
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
