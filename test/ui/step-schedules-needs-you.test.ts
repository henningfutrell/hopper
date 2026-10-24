// A step schedule whose last run failed waits on a person (issue #2716): the Schedules row of Needs you names each, with
// how it ended and why, and the command that shows its output; a run that succeeded takes it off.
import { describe, expect, it } from 'vitest';
import type { StepSchedulesView, StepScheduleView } from '../../src/domain/step-schedules.ts';
import { needsYouRows, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { failedScheduleLines } from '../../ui/src/model/step-schedules.ts';

const schedule = (name: string, run: Partial<NonNullable<StepScheduleView['lastRun']>>): StepScheduleView => ({
  name, template: 't', repo: 'o/r', input: 'a', script: 'a/s.sh', daily: '02:00', timeoutSeconds: 60, savedBy: 'Pat', savedAt: '2026-10-20T00:00:00Z', nextDue: '2026-10-26T02:00:00Z',
  lastRun: { id: name, schedule: name, due: '2026-10-25T02:00:00Z', trigger: 'due', box: 'b', startedAt: '2026-10-25T02:00:01Z', endedAt: '2026-10-25T02:03:00Z', ...run },
});

describe('failed scheduled runs on Needs you (issue #2716)', () => {
  it('one line per schedule whose newest run did not succeed', () => {
    const view: StepSchedulesView = {
      schedules: [schedule('ok', { outcome: 'succeeded', exit: 0 }), schedule('exits', { outcome: 'failed', exit: 2 }), schedule('grant', { outcome: 'failed', exit: 125, problem: 'schedule grant has no vault grant' })],
      failed: ['exits', 'grant'],
    };
    const lines = failedScheduleLines(view);
    expect(lines).toEqual([
      'exits: failed at 2026-10-25T02:03:00Z: the script exited 2. Its output: hopper schedule runs exits',
      'grant: failed at 2026-10-25T02:03:00Z: schedule grant has no vault grant. Its output: hopper schedule runs grant',
    ]);
    const none = { n: 0, high: 0 };
    const counts: NeedsYouCounts = { intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0, failedSchedules: lines,
      sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none } };
    const row = needsYouRows(counts).find((r) => r.kind === 'schedules')!;
    expect(row).toMatchObject({ label: 'Schedules', n: 2, details: lines });
    expect(failedScheduleLines(undefined)).toEqual([]);
  });
});
