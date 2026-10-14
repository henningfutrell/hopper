// A failure a job reported as a hopper bug (issue #1147), pure: a failure the rules hand to a person, of a job that
// reported a hopper bug about itself, is held on its report's problem; any other decision stands. Its fix landed once the
// report's issue is closed as completed and this hopper's build is newer than that close.
import { describe, expect, it } from 'vitest';
import type { BugReport } from '../../src/domain/bug-reports.ts';
import { DEFAULT_FAILURE_SETTINGS, type FailureSettings } from '../../src/domain/types.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause } from '../../src/failures/causes.ts';
import { fixLanded, ownReport, reportsOf, reportSignature } from '../../src/failures/hopper-bug.ts';
import { signatureOf } from '../../src/failures/signature.ts';

const BUG = { title: 'Hopper bug #1147', reason: 'it reported a hopper bug (#1147): it waits for the fix, then runs again' };

function input(error: string, over: Partial<AssessInput> = {}, settings: Partial<FailureSettings> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, ...settings }, hopperBug: BUG, ...over,
  };
}

const report = (over: Partial<BugReport> = {}): BugReport => ({
  id: 'r1', createdAt: '2026-10-14T21:00:00Z', by: 'job j1', jobId: 'j1', fromJob: true, title: 'A bug', state: 'open', kind: 'issue', number: 1147, tries: 1, ...over,
});

describe('a failure a job reported as a hopper bug', () => {
  it('one the rules hand to a person is held on its report: a new problem, or the open one', () => {
    const a = assess(input('HOPPER_FAILED the push was refused'));
    expect(a).toMatchObject({ cls: 'shared', decision: 'hold', auto: true, problem: { kind: 'open', title: BUG.title, scope: {}, general: false, decision: 'hold', causeId: 'hopper-bug' } });
    expect(a.reasons[0]).toBe(BUG.reason);
    expect(a.summary).toMatch(/^Held: Hopper bug #1147\. /);
    expect(assess(input('HOPPER_FAILED the push was refused', { hopperBug: { ...BUG, open: 'p1' } })).problem).toEqual({ kind: 'join', id: 'p1' });
  });

  it('any other decision stands: a retry, or a person while automatic hold is off', () => {
    expect(assess(input('read ECONNRESET'))).toMatchObject({ decision: 'retry' });
    expect(assess(input('HOPPER_FAILED the push was refused', {}, { auto: { ...DEFAULT_FAILURE_SETTINGS.auto, hold: false } }))).toMatchObject({ decision: 'person' });
  });

  it('a job\'s own report is one it filed itself', () => {
    expect(ownReport([report({ fromJob: undefined, by: 'a person' }), report({ id: 'r2' })], 'j1')?.id).toBe('r2');
    expect(ownReport([report()], 'j2')).toBeUndefined();
  });

  it('a problem waits on every report of its issue; a report not sent yet, on itself', () => {
    const reports = [report(), report({ id: 'r2', kind: 'comment' }), report({ id: 'r3', number: 9 }), report({ id: 'r4', state: 'waiting', number: undefined })];
    expect(reportsOf(reportSignature(report()), reports).map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(reportsOf(reportSignature(reports[3]!), reports).map((r) => r.id)).toEqual(['r4']);
  });

  it('its fix landed once closed as completed, and this build is newer than the close', () => {
    const closed = report({ state: 'closed', closedAs: 'completed', closedAt: '2026-10-14T22:00:00Z' });
    expect(fixLanded(closed, '2026-10-14T23:00:00Z')).toBe(true);
    expect(fixLanded(closed, '2026-10-14T21:00:00Z')).toBe(false);
    expect(fixLanded(closed)).toBe(true);
    expect(fixLanded(report({ state: 'closed', closedAs: 'not_planned', closedAt: '2026-10-14T22:00:00Z' }))).toBe(false);
    expect(fixLanded(report())).toBe(false);
  });
});
