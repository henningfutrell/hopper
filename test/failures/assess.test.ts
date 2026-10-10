// The assessor's judgement (issue #509), pure: transient → retry with backoff within the limit, then a person;
// a shared cause → one problem, held or redirected; a signature that recurs across jobs → a general cause, grouped;
// anything else → a person. An automatic action switched off in the settings still decides, but does not act.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type FailureSettings } from '../../src/domain/types.ts';
import { assess, backoffMs, STALE_AFTER_MS, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';

function input(error: string, over: Partial<AssessInput> = {}, settings: Partial<FailureSettings> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []),
    job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, ...settings }, ...over,
  };
}

describe('backoffMs', () => {
  const s = { ...DEFAULT_FAILURE_SETTINGS, backoffSec: 30, backoffFactor: 2, backoffMaxSec: 100 };
  it('grows by the factor from the base, capped at the most', () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, s))).toEqual([30_000, 60_000, 100_000, 100_000]);
  });
});

describe('assess', () => {
  it('transient: retried with backoff while under the limit', () => {
    const a = assess(input('interrupted by daemon restart', { attempt: 2 }, { backoffSec: 10, backoffFactor: 3, maxAttempts: 3 }));
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry', auto: true, retryInMs: 30_000 });
    expect(a.reasons.join(' ')).toMatch(/Daemon restart/);
    expect(a.reasons.join(' ')).toMatch(/retry 2 of 3/);
  });

  it('transient at the limit: a person, saying the limit was reached', () => {
    const a = assess(input('read ECONNRESET', { attempt: 4 }, { maxAttempts: 3 }));
    expect(a).toMatchObject({ cls: 'transient', decision: 'person' });
    expect(a.retryInMs).toBeUndefined();
    expect(a.reasons.join(' ')).toMatch(/retry limit reached: 3 retries/);
  });

  it('no retries at all when the limit is 0', () => {
    expect(assess(input('read ECONNRESET', {}, { maxAttempts: 0 })).decision).toBe('person');
  });

  it('a known shared cause opens a problem scoped to the machine, redirected when the job may go elsewhere', () => {
    const a = assess(input('write: ENOSPC: no space left on device'));
    expect(a).toMatchObject({ cls: 'shared', decision: 'redirect', auto: true });
    expect(a.problem).toEqual({ kind: 'open', title: 'Disk full on desk', scope: { machineId: 'desk' }, general: false, decision: 'redirect', causeId: 'disk-full' });
  });

  it('a job pinned to that machine is held, not redirected', () => {
    const a = assess(input('write: ENOSPC: no space left on device', { job: { executor: 'herdr-claude', machineId: 'desk', pinned: true } }));
    expect(a.decision).toBe('hold');
    expect(a.problem).toMatchObject({ kind: 'open', decision: 'redirect' });
  });

  it('an expired login holds the jobs of that executor on that machine', () => {
    const a = assess(input('claude: Not logged in · Please run /login'));
    expect(a).toMatchObject({ cls: 'shared', decision: 'hold' });
    expect(a.problem).toMatchObject({ kind: 'open', title: 'Login expired on desk', scope: { machineId: 'desk', executor: 'herdr-claude' } });
  });

  it('joins the open problem of its signature', () => {
    const a = assess(input('write: ENOSPC: no space left on device', { open: { id: 'p1', title: 'Disk full on desk', decision: 'hold' } }));
    expect(a).toMatchObject({ cls: 'shared', decision: 'hold', problem: { kind: 'join', id: 'p1' } });
    expect(a.reasons.join(' ')).toMatch(/Disk full on desk/);
  });

  it('a signature that recurs across jobs is flagged as a general cause, grouped and held', () => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'herdr-claude' }];
    const a = assess(input('HOPPER_FAILED the build tool crashed', { recent }, { groupThreshold: 3 }));
    expect(a).toMatchObject({ cls: 'shared', decision: 'hold' });
    expect(a.problem).toMatchObject({ kind: 'open', general: true, scope: { machineId: 'desk', executor: 'herdr-claude' }, decision: 'hold' });
    expect(a.reasons.join(' ')).toMatch(/3 jobs failed with this signature/);
  });

  it('below the threshold the same text is still job-specific', () => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }];
    expect(assess(input('HOPPER_FAILED the build tool crashed', { recent }, { groupThreshold: 3 })).decision).toBe('person');
  });

  it('recurrence across machines on one executor is scoped to that executor', () => {
    const recent = [{ jobId: 'a', machineId: 'box', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'laptop', executor: 'herdr-claude' }];
    const a = assess(input('HOPPER_FAILED the build tool crashed', { recent }, { groupThreshold: 3 }));
    expect(a.problem).toMatchObject({ kind: 'open', general: true, scope: { executor: 'herdr-claude' } });
  });

  it('recurrence with no shared machine and no shared executor is not grouped (issue #625)', () => {
    const recent = [{ jobId: 'a', machineId: 'box', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'laptop', executor: 'codex' }];
    const a = assess(input('HOPPER_FAILED the build tool crashed', { recent }, { groupThreshold: 3 }));
    expect(a).toMatchObject({ cls: 'job', decision: 'person' });
    expect(a.problem).toBeUndefined();
  });

  it.each([
    ['not-complete', 'not complete: no pull request of its own closes the issue'],
    ['invalid-spec', 'invalid payload: repo must be a string'],
    ['question-unanswered', 'question unanswered'],
  ])('a job-specific cause (%s) on many jobs of one machine is never a general cause (issue #625)', (id, error) => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'herdr-claude' }];
    const a = assess(input(error, { recent }, { groupThreshold: 3 }));
    expect(a.reasons.join(' ')).toContain(`known cause: `);
    expect(input(error).cause?.id).toBe(id);
    expect(a).toMatchObject({ cls: 'job', decision: 'person' });
    expect(a.problem).toBeUndefined();
    expect(a.summary).not.toMatch(/Recurring/);
  });

  it('a transient cause on many jobs of one machine is grouped as a general cause', () => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'codex' }];
    const a = assess(input('read ECONNRESET', { recent }, { groupThreshold: 3 }));
    expect(a).toMatchObject({ cls: 'shared', decision: 'hold' });
    expect(a.problem).toMatchObject({ kind: 'open', general: true, scope: { machineId: 'desk' }, causeId: 'network' });
  });

  it('job-specific: a person, with a summary of what was tried and what failed', () => {
    const a = assess(input('HOPPER_FAILED the tests do not pass', { attempt: 2, ranMs: 125_000, tail: 'npm test\n3 failing' }));
    expect(a).toMatchObject({ cls: 'job', decision: 'person' });
    expect(a.summary).toBe('Needs a person. Ran 2 times on desk, the last for 2 min. Failed: HOPPER_FAILED the tests do not pass. Output: 3 failing');
  });

  it('a known job-specific cause names itself', () => {
    expect(assess(input('question unanswered')).reasons.join(' ')).toMatch(/Question unanswered/);
  });

  it('automatic actions off: the decision stands, but waits for a person', () => {
    const off = { auto: { retry: false, hold: false, redirect: false, continue: false } };
    expect(assess(input('read ECONNRESET', {}, off))).toMatchObject({ decision: 'retry', auto: false });
    expect(assess(input('no space left on device', {}, off))).toMatchObject({ decision: 'hold', auto: false });
  });

  it('redirect off: held instead', () => {
    expect(assess(input('no space left on device', {}, { auto: { retry: true, hold: true, redirect: false, continue: true } }))).toMatchObject({ decision: 'hold', auto: true });
  });

  it('a job with no machine is held, never redirected', () => {
    const a = assess(input('no space left on device', { job: { executor: 'test', pinned: false } }));
    expect(a.decision).toBe('hold');
    expect(a.problem).toMatchObject({ kind: 'open', title: 'Disk full', scope: {} });
  });
});

describe('assess: a failure whose item already ran again (issue #517)', () => {
  it('is superseded: no retry, no problem, and not for a person', () => {
    const a = assess(input('HOPPER_FAILED the tests do not pass', { newer: 'j2' }));
    expect(a).toMatchObject({ superseded: 'j2', cls: 'job' });
    expect(a.problem).toBeUndefined();
    expect(a.retryInMs).toBeUndefined();
    expect(a.summary).toMatch(/^Already run again \(job j2\)\. Ran 1 time on desk\. Failed: HOPPER_FAILED the tests do not pass\.$/);
    expect(a.reasons.join(' ')).toMatch(/a newer job of its item exists: j2/);
  });

  it('a shared or transient cause neither opens a problem nor retries', () => {
    const shared = assess(input('no space left on device', { newer: 'j2' }));
    expect(shared.superseded).toBe('j2');
    expect(shared.problem).toBeUndefined();
    const transient = assess(input('read ECONNRESET', { newer: 'j2' }));
    expect(transient.superseded).toBe('j2');
    expect(transient.retryInMs).toBeUndefined();
    expect(assess(input('no space left on device', { newer: 'j2', open: { id: 'p1', title: 'Disk full on desk', decision: 'hold' } })).problem).toBeUndefined();
  });
});

describe('assess: a failure older than a day when assessed (issue #517)', () => {
  const old = { failedAgoMs: STALE_AFTER_MS + 1 };

  it('the decision stands, but takes no automatic action: it waits on a person', () => {
    const a = assess(input('read ECONNRESET', old));
    expect(a).toMatchObject({ decision: 'retry', auto: false, cls: 'transient' });
    expect(a.retryInMs).toBeUndefined();
    expect(a.summary).toMatch(/^Retry recommended\./);
    expect(a.reasons.join(' ')).toMatch(/failed 1 d before it was assessed/);
  });

  it('a shared cause opens or joins no problem: it is too old to hold or redirect other jobs', () => {
    const a = assess(input('write: ENOSPC: no space left on device', { ...old, open: { id: 'p1', title: 'Disk full on desk', decision: 'hold' } }));
    expect(a).toMatchObject({ decision: 'redirect', auto: false, cls: 'shared' });
    expect(a.problem).toBeUndefined();
    expect(a.summary).toMatch(/^Redirect recommended: Disk full\./);
  });

  it('recurrence does not group it either', () => {
    const recent = [{ jobId: 'a', executor: 'herdr-claude' }, { jobId: 'b', executor: 'herdr-claude' }];
    const a = assess(input('HOPPER_FAILED the build tool crashed', { ...old, recent }, { groupThreshold: 3 }));
    expect(a.decision).toBe('person');
    expect(a.problem).toBeUndefined();
  });

  it('a day or less is not old', () => {
    expect(assess(input('read ECONNRESET', { failedAgoMs: STALE_AFTER_MS }))).toMatchObject({ decision: 'retry', auto: true });
  });
});

describe('assess: a timed-out job, from its liveness (issue #630)', () => {
  const MIN = 60_000;
  const timedOut = (over: Partial<AssessInput> = {}, settings: Partial<FailureSettings> = {}) => assess(input('timed out', over, settings));

  it('the timeout is a known cause', () => {
    expect(timedOut().reasons[0]).toBe('known cause: Timed out');
  });

  it('active by its pane output alone: output changed within the window — Continue', () => {
    const a = timedOut({ liveness: { outputAgoMs: 9 * MIN, pushed: false, pullRequest: false } });
    expect(a).toMatchObject({ cls: 'transient', decision: 'continue', auto: true });
    expect(a.reasons.join(' ')).toMatch(/pane output changed 9 min before the timeout/);
    expect(a.summary).toMatch(/^Continues: it was at work\./);
  });

  it('active by pushed commits alone — Continue', () => {
    const a = timedOut({ liveness: { pushed: true } });
    expect(a.decision).toBe('continue');
    expect(a.reasons.join(' ')).toMatch(/commits pushed/);
  });

  it('active by an open pull request alone — Continue', () => {
    const a = timedOut({ liveness: { outputAgoMs: 60 * MIN, pullRequest: true } });
    expect(a.decision).toBe('continue');
    expect(a.reasons.join(' ')).toMatch(/a pull request of its own is open/);
  });

  it('the window is the setting: output older than it is silent', () => {
    expect(timedOut({ liveness: { outputAgoMs: 9 * MIN } }, { activeWindowMin: 5 }).decision).toBe('retry');
    expect(timedOut({ liveness: { outputAgoMs: 11 * MIN } }).decision).toBe('retry');
  });

  it('silent — no recent output, no commits, no pull request: Retry once', () => {
    const a = timedOut({ liveness: { outputAgoMs: 30 * MIN, pushed: false, pullRequest: false } });
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry', auto: true });
    expect(a.retryInMs).toBeGreaterThan(0);
    expect(a.reasons.join(' ')).toMatch(/silent: no pane output for 30 min, no commits pushed, no pull request/);
  });

  it('no liveness facts at all is silent', () => {
    expect(timedOut().decision).toBe('retry');
  });

  it('a pull request it could not look up is not known: the other facts decide', () => {
    expect(timedOut({ liveness: { outputAgoMs: 30 * MIN, pushed: false } }).reasons.join(' ')).toMatch(/pull request not known/);
  });

  it('a second silent timeout after that retry goes to a person', () => {
    const a = timedOut({ liveness: { outputAgoMs: 30 * MIN }, earlierTimeouts: ['silent'] });
    expect(a).toMatchObject({ decision: 'person' });
    expect(a.reasons.join(' ')).toMatch(/silent again after its retry/);
  });

  it('silent after active runs is retried once', () => {
    expect(timedOut({ earlierTimeouts: ['active', 'active'] }).decision).toBe('retry');
  });

  it('active after a silent retry is continued', () => {
    expect(timedOut({ liveness: { pushed: true }, earlierTimeouts: ['silent'] }).decision).toBe('continue');
  });

  it('the cap: the third active timeout in a row goes to a person', () => {
    expect(timedOut({ liveness: { pushed: true }, earlierTimeouts: ['active'] }).decision).toBe('continue');
    const a = timedOut({ liveness: { pushed: true }, earlierTimeouts: ['active', 'active'] });
    expect(a.decision).toBe('person');
    expect(a.reasons.join(' ')).toMatch(/3 timeouts in a row while at work/);
  });

  it('only consecutive active timeouts count toward the cap', () => {
    expect(timedOut({ liveness: { pushed: true }, earlierTimeouts: ['active', 'silent', 'active'] }).decision).toBe('continue');
  });

  it('a timeout never forms a Recurring problem, nor joins one', () => {
    const recent = [{ jobId: 'a', executor: 'herdr-claude' }, { jobId: 'b', executor: 'herdr-claude' }];
    const a = timedOut({ recent, open: { id: 'p1', title: 'Recurring: timed out', decision: 'hold' }, liveness: { pushed: true } });
    expect(a.decision).toBe('continue');
    expect(a.problem).toBeUndefined();
  });

  it('automatic continue off: it waits for a person', () => {
    const a = timedOut({ liveness: { pushed: true } }, { auto: { ...DEFAULT_FAILURE_SETTINGS.auto, continue: false } });
    expect(a).toMatchObject({ decision: 'continue', auto: false });
    expect(a.summary).toMatch(/^Continue recommended\./);
  });
});
