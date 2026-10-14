// The watchers of the hopper's own records (issue #1077, the next part): the ledger against the job records, and the lanes
// against the jobs. Each reads the store in one pass and answers the drift; the store here is a fake at its port.
import { describe, expect, it } from 'vitest';
import { lanesJobsWatcher, ledgerJobsWatcher } from '../../src/component-watchers/store-watchers.ts';
import type { JobFilter } from '../../src/domain/store.ts';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';

const job = (id: string, status: JobStatus, key?: string): Job => ({
  id, status, spec: { prompt: 'p' }, priority: 50, approved: false, createdAt: HOUR_AGO, updatedAt: HOUR_AGO,
  ...(key ? { source: { source: 'github', kind: 'issue', key } } : {}),
} as unknown as Job);
const item = (key: string, state: WorkItemState, jobId: string): WorkItem => ({ key, state, stateSince: HOUR_AGO, eventState: state, eventAt: HOUR_AGO, jobId, keptWork: [], version: 1 });

function fakeJobs(all: Job[]) {
  return {
    get: (id: string) => all.find((j) => j.id === id),
    list: (f?: JobFilter) => all.filter((j) => !f?.status || f.status.includes(j.status)),
  };
}

describe('the ledger-vs-jobs watcher', () => {
  it('reads the active items with their jobs, and the active jobs with their items', async () => {
    const items = [item('k1', 'working', 'j1'), item('k2', 'failed', 'j2'), item('k3', 'done', 'j3')];
    const w = ledgerJobsWatcher({
      ledger: { list: (f) => items.filter((i) => !f?.state || f.state.includes(i.state)), get: (k) => items.find((i) => i.key === k) },
      jobs: fakeJobs([job('j1', 'failed', 'k1'), job('j2', 'running', 'k2'), job('j3', 'finished', 'k3')]),
      now: () => NOW,
    });
    expect(w).toMatchObject({ name: 'ledger-jobs', component: 'the work-item ledger', truth: 'the job records', intervalMs: 300_000 });
    expect((await w.check()).map((d) => [d.kind, d.items.map((i) => i.key)])).toEqual([
      ['active_but_job_ended', ['k1']],
      ['ended_but_job_active', ['k2']],
    ]);
  });
});

describe('the lanes-vs-jobs watcher', () => {
  it('reads every lane and the jobs that hold one or that a lane names', async () => {
    const lanes: Lane[] = [{ id: 'desk/lane-1', machineId: 'desk', state: 'busy', jobId: 'j1', openedAt: HOUR_AGO }];
    const w = lanesJobsWatcher({ lanes: { list: () => lanes }, jobs: fakeJobs([job('j1', 'cancelled'), job('j2', 'running')]), now: () => NOW });
    expect(w).toMatchObject({ name: 'lanes-jobs', component: 'the lanes', truth: 'the job records', intervalMs: 300_000 });
    expect((await w.check()).map((d) => [d.kind, d.items.map((i) => i.key)])).toEqual([
      ['lane_busy_job_not_running', ['desk/lane-1']],
      ['job_running_no_lane', ['j2']],
    ]);
  });
});
