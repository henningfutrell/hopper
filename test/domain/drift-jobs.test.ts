// Drift between the hopper's own records (issue #1077, the next part): the work-item ledger against the job records, and
// the lanes against the jobs they run. A job or an item that changed in the grace is no drift yet.
//
// Feature: the ledger-vs-jobs and lanes-vs-jobs comparisons
//   Scenario: the ledger says an item is at work while its job ended, or ended while its job is at work
//   Scenario: the ledger's active state is not the one its job's status gives
//   Scenario: a hand-off on a failed job, or an operator-led job, is no drift
//   Scenario: a lane busy with a job that does not run, and a job that runs with no lane
import { describe, expect, it } from 'vitest';
import { LANES_JOBS, LEDGER_JOBS, lanesJobsDrift, ledgerJobsDrift } from '../../src/domain/drift-jobs.ts';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';
const MINUTE_AGO = '2026-10-13T11:59:00.000Z';
const GRACE = 5 * 60_000;

const job = (id: string, status: JobStatus, extra: Partial<Job> = {}): Job => ({
  id, status, spec: { prompt: 'p' }, priority: 50, approved: false, createdAt: HOUR_AGO, updatedAt: HOUR_AGO, ...extra,
} as Job);
const item = (n: number, state: WorkItemState, jobId: string | undefined, extra: Partial<WorkItem> = {}): WorkItem => ({
  key: `https://github.com/o/r/issues/${n}`, state, stateSince: HOUR_AGO, eventState: state, eventAt: HOUR_AGO, keptWork: [], version: 1,
  ...(jobId ? { jobId } : {}), ...extra,
});
const lane = (id: string, state: Lane['state'], jobId?: string): Lane => ({ id, machineId: 'desk', state, openedAt: HOUR_AGO, ...(jobId ? { jobId } : {}) });

describe('ledger-vs-jobs drift', () => {
  it('finds an item at work in the ledger whose job ended or is gone', () => {
    expect(ledgerJobsDrift([
      { item: item(1, 'working', 'j1'), job: job('j1', 'finished', { finishedAt: HOUR_AGO }) },
      { item: item(2, 'queued', 'j2'), job: undefined },
    ], NOW, GRACE)).toEqual([{
      watcher: LEDGER_JOBS, kind: 'active_but_job_ended', items: [
        { key: 'https://github.com/o/r/issues/1', says: 'working', truth: 'job finished', since: HOUR_AGO },
        { key: 'https://github.com/o/r/issues/2', says: 'queued', truth: 'no such job' },
      ],
    }]);
  });

  it('finds an item ended in the ledger whose job is at work', () => {
    expect(ledgerJobsDrift([{ item: item(3, 'failed', 'j3'), job: job('j3', 'running') }], NOW, GRACE)).toEqual([{
      watcher: LEDGER_JOBS, kind: 'ended_but_job_active', items: [{ key: 'https://github.com/o/r/issues/3', says: 'failed', truth: 'job running', since: HOUR_AGO }],
    }]);
  });

  it('finds an active state the job\'s status does not give', () => {
    expect(ledgerJobsDrift([
      { item: item(4, 'queued', 'j4'), job: job('j4', 'running') },
      { item: item(5, 'working', 'j5'), job: job('j5', 'parked') },
    ], NOW, GRACE).map((d) => [d.kind, d.items.map((i) => [i.says, i.truth])])).toEqual([
      ['state_differs', [['queued', 'job running'], ['working', 'job parked']]],
    ]);
  });

  it('finds no drift when they agree, for a hand-off on the failed job, an operator-led job, or a change in the grace', () => {
    expect(ledgerJobsDrift([
      { item: item(1, 'working', 'j1'), job: job('j1', 'running') },
      { item: item(2, 'needs_you', 'j2'), job: job('j2', 'waiting_answer') },
      { item: item(3, 'working', 'j3', { waitingOn: 'its build' }), job: job('j3', 'waiting_on') },
      { item: item(4, 'done', 'j4'), job: job('j4', 'finished') },
      { item: item(5, 'needs_you', 'j5', { failedJobId: 'j5', waitingOn: 'a hand-off' }), job: job('j5', 'failed') },
      { item: item(6, 'working', 'j6'), job: job('j6', 'operator_led') },
      { item: item(7, 'working', 'j7'), job: job('j7', 'finished', { updatedAt: MINUTE_AGO }) },
      { item: item(8, 'failed', 'j8', { eventAt: MINUTE_AGO }), job: job('j8', 'running') },
    ], NOW, GRACE)).toEqual([]);
  });
});

describe('lanes-vs-jobs drift', () => {
  it('finds a lane busy with a job that does not run, and a job that runs with no lane', () => {
    const jobs = [job('j1', 'finished', { finishedAt: HOUR_AGO }), job('j2', 'running', { startedAt: HOUR_AGO }), job('j3', 'claimed')];
    const drift = lanesJobsDrift([lane('desk/lane-1', 'busy', 'j1'), lane('desk/lane-2', 'idle'), lane('desk/lane-3', 'busy', 'j9')], jobs, NOW, GRACE);
    expect(drift).toEqual([
      { watcher: LANES_JOBS, kind: 'lane_busy_job_not_running', items: [
        { key: 'desk/lane-1', says: 'busy with a job', truth: 'job finished', since: HOUR_AGO },
        { key: 'desk/lane-3', says: 'busy with a job', truth: 'no such job' },
      ] },
      { watcher: LANES_JOBS, kind: 'job_running_no_lane', items: [
        { key: 'j2', says: 'no lane runs it', truth: 'job running', since: HOUR_AGO },
        { key: 'j3', says: 'no lane runs it', truth: 'job claimed' },
      ] },
    ]);
  });

  it('finds no drift when each running job has its busy or draining lane, or the job changed in the grace', () => {
    const jobs = [job('j1', 'running'), job('j2', 'claimed'), job('j3', 'finished', { updatedAt: MINUTE_AGO }), job('j4', 'running', { updatedAt: MINUTE_AGO })];
    expect(lanesJobsDrift([lane('desk/lane-1', 'busy', 'j1'), lane('desk/lane-2', 'draining', 'j2'), lane('desk/lane-3', 'busy', 'j3')], jobs, NOW, GRACE)).toEqual([]);
  });
});
