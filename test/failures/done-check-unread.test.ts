// Done check unread (issue #2235): a job that ended done, whose completion check could not read its source (a connect
// timeout, a 5xx, a rate limit), is not Not complete: nothing showed the work incomplete. The cause is transient, ahead
// of every other cause the read error's text could match, and the assessor runs it again.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS } from '../../src/domain/types.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';

const CONNECT_TIMEOUT = 'could not confirm the work is complete: get o/r#1570: Connect Timeout Error (attempted address: api.github.com:443, timeout: 10000ms)';

function input(error: string, over: Partial<AssessInput> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, maxAttempts: 3 }, ...over,
  };
}

describe('the cause Done check unread', () => {
  it.each([
    CONNECT_TIMEOUT,
    'could not confirm the work is complete: gh: 502 Bad Gateway',
    'could not confirm the work is complete: API rate limit exceeded',
    'could not confirm the work is complete: connect ECONNREFUSED 140.82.112.6:443',
    'could not confirm the work is complete: Bad credentials',
  ])('matches a completion check that could not read its source, not Not complete: %s', (error) => {
    expect(input(error).cause).toMatchObject({ id: 'done-check-unread', name: 'Done check unread', cls: 'transient', decision: 'retry' });
  });

  it('runs the job again, never hands it to a person, and names the read error', () => {
    const a = assess(input(CONNECT_TIMEOUT));
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry' });
    expect(a.reasons.join(' ')).toContain('known cause: Done check unread');
  });

  it('leaves a miss Not complete', () => {
    expect(input('not complete: the issue https://github.com/o/r/issues/1 is open, and no pull request in o/r closes or references it').cause?.id).toBe('not-complete');
  });
});
