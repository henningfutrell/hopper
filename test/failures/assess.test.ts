// The assessor's judgement (issue #509), pure: transient → retry with backoff within the limit, then a person;
// a shared cause → one problem, held or redirected; a signature that recurs across jobs → a general cause, grouped;
// anything else → a person. An automatic action switched off in the settings still decides, but does not act.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type FailureSettings } from '../../src/domain/types.ts';
import { assess, backoffMs, type AssessInput } from '../../src/failures/assess.ts';
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

  it('recurrence across machines is scoped to every machine', () => {
    const recent = [{ jobId: 'a', machineId: 'box', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'codex' }];
    const a = assess(input('HOPPER_FAILED the build tool crashed', { recent }, { groupThreshold: 3 }));
    expect(a.problem).toMatchObject({ kind: 'open', scope: {} });
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
    const off = { auto: { retry: false, hold: false, redirect: false } };
    expect(assess(input('read ECONNRESET', {}, off))).toMatchObject({ decision: 'retry', auto: false });
    expect(assess(input('no space left on device', {}, off))).toMatchObject({ decision: 'hold', auto: false });
  });

  it('redirect off: held instead', () => {
    expect(assess(input('no space left on device', {}, { auto: { retry: true, hold: true, redirect: false } }))).toMatchObject({ decision: 'hold', auto: true });
  });

  it('a job with no machine is held, never redirected', () => {
    const a = assess(input('no space left on device', { job: { executor: 'test', pinned: false } }));
    expect(a.decision).toBe('hold');
    expect(a.problem).toMatchObject({ kind: 'open', title: 'Disk full', scope: {} });
  });
});
