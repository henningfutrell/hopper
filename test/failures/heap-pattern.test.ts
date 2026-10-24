// A heap abort pattern (issue #2722), pure: a command that ran out of heap in enough jobs within a day is a pattern, and a
// failed job of it that the rules would run again or hand to a person is held on the command's problem instead.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type DomainEvent, type FailureSettings } from '../../src/domain/types.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { heapAbortsSeen, heapPatternOf, heapSignature, type HeapAbortSeen } from '../../src/failures/heap-pattern.ts';
import { signatureOf } from '../../src/failures/signature.ts';

const TSC = 'tsc --noEmit -p .';
const SINCE = '2026-10-23T12:00:00.000Z';
const seen = (jobId: string, command = TSC, at = '2026-10-24T10:00:00.000Z'): HeapAbortSeen => ({ jobId, command, at });

describe('a heap abort pattern', () => {
  it('is a command of the job that ran out of heap in enough jobs; a job counts once', () => {
    const p = heapPatternOf([seen('j1'), seen('j1'), seen('j2'), seen('j3')], 'j3', 3, SINCE);
    expect(p).toEqual({
      command: TSC, jobs: 3, signature: heapSignature(TSC), title: `Heap abort: ${TSC}`,
      reason: `${TSC} ran out of heap in 3 jobs within a day: running it again does not help, it waits for a fix or more heap`,
    });
    expect(heapPatternOf([seen('j1'), seen('j1'), seen('j3')], 'j3', 3, SINCE)).toBeUndefined();
  });

  it('counts only the job\'s own commands, and the command of the most jobs', () => {
    const all = [seen('j1', 'vite build'), seen('j2', 'vite build'), seen('j4', 'vite build'), seen('j1'), seen('j2'), seen('j3', 'vitest run')];
    expect(heapPatternOf(all, 'j3', 3, SINCE)).toBeUndefined();
    expect(heapPatternOf([...all, seen('j3'), seen('j3', 'vite build')], 'j3', 3, SINCE)?.command).toBe('vite build');
  });

  it('counts other jobs\' aborts only within the window, and after the command\'s problem was resolved', () => {
    const all = [seen('j1', TSC, '2026-10-22T10:00:00.000Z'), seen('j2'), seen('j3')];
    expect(heapPatternOf(all, 'j3', 3, SINCE)).toBeUndefined();
    expect(heapPatternOf(all, 'j3', 3, '2026-10-22T00:00:00.000Z')?.jobs).toBe(3);
    expect(heapPatternOf(all, 'j3', 3, '2026-10-22T00:00:00.000Z', { [heapSignature(TSC)]: '2026-10-24T09:00:00.000Z' })).toBeUndefined();
  });

  it('reads the job.heap_aborted events', () => {
    const e = (type: string, data: unknown, jobId?: string): DomainEvent => ({ seq: 1, id: 'e', type, at: '2026-10-24T10:00:00.000Z', data, ...(jobId ? { jobId } : {}) } as DomainEvent);
    expect(heapAbortsSeen([e('job.heap_aborted', { command: TSC }, 'j1'), e('job.heap_aborted', { command: TSC }), e('job.heap_aborted', {}, 'j2'), e('job.failed', { command: TSC }, 'j3')]))
      .toEqual([{ jobId: 'j1', command: TSC, at: '2026-10-24T10:00:00.000Z' }]);
  });
});

const PATTERN = { title: `Heap abort: ${TSC}`, reason: `${TSC} ran out of heap in 3 jobs within a day: running it again does not help, it waits for a fix or more heap` };

function input(error: string, over: Partial<AssessInput> = {}, settings: Partial<FailureSettings> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, ...settings }, heapPattern: PATTERN, ...over,
  };
}

describe('a failed job of a heap abort pattern', () => {
  it('is held on the command\'s problem in place of a retry or a person: a new problem, or the open one', () => {
    for (const error of ['read ECONNRESET', 'HOPPER_FAILED the type check aborted']) {
      const a = assess(input(error));
      expect(a).toMatchObject({ cls: 'shared', decision: 'hold', auto: true, problem: { kind: 'open', title: PATTERN.title, scope: {}, general: false, decision: 'hold', causeId: 'heap-abort' } });
      expect(a.reasons[0]).toBe(PATTERN.reason);
      expect(a.summary).toMatch(/^Held: Heap abort: tsc --noEmit -p \.\. /);
    }
    expect(assess(input('read ECONNRESET', { heapPattern: { ...PATTERN, open: 'p1' } })).problem).toEqual({ kind: 'join', id: 'p1' });
  });

  it('keeps a shared cause\'s problem, a superseded or stale decision, and a person while automatic hold is off', () => {
    expect(assess(input('ENOSPC: no space left on device'))).toMatchObject({ decision: 'redirect', problem: { kind: 'open', causeId: 'disk-full' } });
    expect(assess(input('read ECONNRESET', { newer: 'j2' }))).toMatchObject({ decision: 'retry', superseded: 'j2' });
    expect(assess(input('read ECONNRESET', { failedAgoMs: 2 * 86_400_000 }))).toMatchObject({ decision: 'retry', auto: false });
    expect(assess(input('HOPPER_FAILED the type check aborted', {}, { auto: { ...DEFAULT_FAILURE_SETTINGS.auto, hold: false } }))).toMatchObject({ decision: 'person' });
  });
});
