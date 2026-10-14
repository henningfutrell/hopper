// Drift in intake (issue #1077, the third part): items that wait with no action. Intake against the job records — an item
// the last sync took has a job —, and each source's sync against its own timer — a sync is never overdue or stuck.
//
// Feature: the intake-vs-jobs comparison
//   Scenario: an item the last sync took has no job
//   Scenario: a source's next sync is overdue, or its sync runs for too long
//   Scenario: an item not taken, an item with its job, a sync in the grace, or a source that syncs on time is no drift
import { describe, expect, it } from 'vitest';
import { INTAKE_JOBS, intakeJobsDrift, SYNC_STUCK_MS } from '../../src/domain/drift-intake.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job, SourceStatus } from '../../src/domain/types.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';
const MINUTE_AGO = '2026-10-13T11:59:00.000Z';
const IN_A_MINUTE = '2026-10-13T12:01:00.000Z';
const GRACE = 5 * 60_000;

const url = (n: number) => `https://github.com/o/r/issues/${n}`;
const taken = (n: number): IntakeOutcome => ({ key: url(n), title: `t${n}` });
const notTaken = (n: number): IntakeOutcome => ({ key: url(n), title: `t${n}`, reason: 'not assigned to you', group: 'not-assigned' });
const source = (name: string, extra: Partial<SourceStatus> = {}, intake: IntakeOutcome[] = []): SourceStatus => ({
  name, kind: 'github', state: 'ok', lastSyncAt: HOUR_AGO, lastOkAt: HOUR_AGO, nextSyncAt: IN_A_MINUTE, itemsSeen: intake.length, jobsCreated: 0, activeJobs: 0,
  detail: { intake }, ...extra,
});
const job = (id: string): Job => ({ id, status: 'queued', spec: { prompt: 'p' }, priority: 50, approved: false, createdAt: HOUR_AGO, updatedAt: HOUR_AGO } as unknown as Job);

describe('intake-vs-jobs drift', () => {
  it('finds an item the last sync took that has no job', () => {
    const jobs = new Map([[url(1), job('j1')]]);
    expect(intakeJobsDrift([source('github', {}, [taken(1), taken(2), notTaken(3)])], jobs, NOW, GRACE)).toEqual([{
      watcher: INTAKE_JOBS, kind: 'taken_no_job', items: [{ key: url(2), says: 'taken', truth: 'no job', since: HOUR_AGO }],
    }]);
  });

  it('finds a source whose next sync is overdue, and one whose sync runs for too long', () => {
    const longAgo = new Date(Date.parse(NOW) - SYNC_STUCK_MS - 60_000).toISOString();
    const sources = [
      source('late', { nextSyncAt: HOUR_AGO }),
      source('stuck', { syncing: true, lastSyncAt: longAgo, nextSyncAt: undefined }),
    ];
    expect(intakeJobsDrift(sources, new Map(), NOW, GRACE)).toEqual([
      { watcher: INTAKE_JOBS, kind: 'sync_overdue', items: [{ key: 'late', says: `next sync at ${HOUR_AGO}`, truth: 'no sync ran', since: HOUR_AGO }] },
      { watcher: INTAKE_JOBS, kind: 'sync_stuck', items: [{ key: 'stuck', says: 'a sync runs', truth: `no sync ended since ${longAgo}`, since: longAgo }] },
    ]);
  });

  it('finds no drift for items not taken or with a job, a sync in the grace, or a source that syncs on time', () => {
    const jobs = new Map([[url(1), job('j1')]]);
    expect(intakeJobsDrift([
      source('on-time', {}, [taken(1), notTaken(2)]),
      source('fresh', { lastSyncAt: MINUTE_AGO, nextSyncAt: MINUTE_AGO }, [taken(3)]),
      source('syncing', { syncing: true, lastSyncAt: HOUR_AGO, nextSyncAt: undefined }, [taken(1)]),
      source('stopped', { nextSyncAt: undefined }),
      source('no-list', { detail: {} }),
    ], jobs, NOW, GRACE)).toEqual([]);
  });
});
