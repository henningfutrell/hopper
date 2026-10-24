// Step schedules' pure rules (issue #2716, src/domain/step-schedules.ts): when a daily time is due, which due time runs
// after a stop, and what a save may hold.
import { describe, expect, it } from 'vitest';
import { changesWhatRuns, dueNow, failedSchedules, latestDue, nextDue, stepScheduleProblem, type StepScheduleFields, type StepScheduleView } from '../../src/domain/step-schedules.ts';

const FIELDS: StepScheduleFields = { name: 'nightly-backup', template: 'backup', repo: 'acme/ops', input: 'ops/backup', script: 'ops/backup/step.sh', daily: '02:00', timeoutSeconds: 1800 };

describe('when a step schedule is due (issue #2716)', () => {
  it('the newest due time is today\'s once it passed, else yesterday\'s; the next is a day after it', () => {
    expect(latestDue('02:00', new Date('2026-10-25T02:00:00Z')).toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(latestDue('02:00', new Date('2026-10-25T01:59:59Z')).toISOString()).toBe('2026-10-24T02:00:00.000Z');
    expect(nextDue('02:00', new Date('2026-10-25T03:00:00Z')).toISOString()).toBe('2026-10-26T02:00:00.000Z');
    // Across a month's end, in UTC.
    expect(latestDue('23:30', new Date('2026-11-01T00:10:00Z')).toISOString()).toBe('2026-10-31T23:30:00.000Z');
  });

  it('a due time before the schedule was saved never runs', () => {
    expect(dueNow({ daily: '02:00', savedAt: '2026-10-25T03:00:00Z' }, new Date('2026-10-25T09:00:00Z'))).toBeUndefined();
    expect(dueNow({ daily: '02:00', savedAt: '2026-10-25T03:00:00Z' }, new Date('2026-10-26T02:00:01Z'))).toBe('2026-10-26T02:00:00.000Z');
  });

  it('after a stop of three days the newest missed due time is the one due, once; the older ones are not', () => {
    expect(dueNow({ daily: '02:00', savedAt: '2026-10-20T00:00:00Z' }, new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-24T02:00:00.000Z');
  });
});

describe('what a step schedule may hold (issue #2716)', () => {
  it('a schedule as the issue gives it is saved', () => {
    expect(stepScheduleProblem(FIELDS)).toBeUndefined();
  });

  it.each([
    [{ name: 'Nightly' }, /^name:/],
    [{ repo: 'acme' }, /^repo:/],
    [{ input: '../etc' }, /^input:/],
    [{ input: '/abs' }, /^input:/],
    [{ script: 'other/step.sh' }, /^script: a file in the input folder ops\/backup/],
    [{ daily: '24:00' }, /^daily:/],
    [{ daily: '2:00' }, /^daily:/],
    [{ timeoutSeconds: 0 }, /^timeout:/],
    [{ timeoutSeconds: 1.5 }, /^timeout:/],
  ])('%j is refused', (change, why) => {
    expect(stepScheduleProblem({ ...FIELDS, ...change })).toMatch(why);
  });

  it('a change of the template, the repository, the folder or the script changes what runs; a time or timeout does not', () => {
    expect(changesWhatRuns(FIELDS, { ...FIELDS, daily: '03:00', timeoutSeconds: 60 })).toBe(false);
    expect(changesWhatRuns(FIELDS, { ...FIELDS, repo: 'ACME/ops' })).toBe(false);
    for (const change of [{ template: 'x' }, { repo: 'acme/other' }, { input: 'ops' }, { script: 'ops/backup/other.sh' }]) expect(changesWhatRuns(FIELDS, { ...FIELDS, ...change })).toBe(true);
  });

  it('Needs you lists a schedule whose newest run did not succeed, and none that never ran', () => {
    const view = (name: string, outcome?: 'succeeded' | 'failed' | 'interrupted'): StepScheduleView => ({
      ...FIELDS, name, savedBy: 'Pat', savedAt: '2026-10-20T00:00:00Z', nextDue: '2026-10-26T02:00:00Z',
      ...(outcome ? { lastRun: { id: name, schedule: name, due: 'd', trigger: 'due', box: 'b', startedAt: 's', outcome } } : {}),
    });
    expect(failedSchedules([view('a', 'succeeded'), view('b', 'failed'), view('c', 'interrupted'), view('d')])).toEqual(['b', 'c']);
  });
});
