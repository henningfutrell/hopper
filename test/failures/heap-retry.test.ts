// The heap retry in the failure assessment (issue #2722 part 4), pure: a failure the rules hand to a person, of a job whose
// command ran out of heap with no heap retry in its chain yet, runs again once in its place.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type FailureSettings } from '../../src/domain/types.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';

const TSC = 'tsc --noEmit -p .';
const AUTO = DEFAULT_FAILURE_SETTINGS.auto;

function input(error: string, over: Partial<AssessInput> = {}, settings: Partial<FailureSettings> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, ...settings }, heapRetry: { command: TSC }, ...over,
  };
}

describe('the heap retry of a failed job', () => {
  it('runs a failure the rules hand to a person again once, after the first backoff', () => {
    const a = assess(input('HOPPER_FAILED the type check aborted'));
    expect(a).toMatchObject({ cls: 'transient', decision: 'retry', auto: true, retryInMs: 60_000 });
    expect(a.reasons[0]).toBe(`${TSC} ran out of heap: it runs again once, with a larger heap when its machine has room`);
    expect(a.summary).toMatch(/^Heap retry in 1 min\. Ran 1 time on desk\. Failed: HOPPER_FAILED the type check aborted\./);
  });

  it('comes before a repeat stops the item: the larger heap is a change', () => {
    expect(assess(input('HOPPER_FAILED the type check aborted', { repeated: true }))).toMatchObject({ decision: 'retry' });
  });

  it('leaves a retry, a shared cause, a heap abort pattern, and a person while automatic retry is off', () => {
    expect(assess(input('read ECONNRESET'))).toMatchObject({ decision: 'retry', reasons: ['known cause: Network blip', expect.stringMatching(/^transient: retry 1 of 3/)] });
    expect(assess(input('ENOSPC: no space left on device'))).toMatchObject({ decision: 'redirect' });
    expect(assess(input('HOPPER_FAILED the type check aborted', { heapPattern: { title: `Heap abort: ${TSC}`, reason: 'pattern' } }))).toMatchObject({ decision: 'hold' });
    expect(assess(input('HOPPER_FAILED the type check aborted', {}, { auto: { ...AUTO, retry: false } }))).toMatchObject({ decision: 'person' });
    expect(assess(input('HOPPER_FAILED the type check aborted', { heapRetry: undefined }))).toMatchObject({ decision: 'person' });
  });
});
