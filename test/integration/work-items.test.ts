// The work-item ledger end to end (issue #1067): real daemon, real database, the manual source. Each item's state moves
// with its job's events, and GET /api/work-items counts every state from the ledger alone.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job, JobGraph } from '../../src/domain/types.ts';
import type { WorkItem, WorkItemState } from '../../src/domain/work-items.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

type Ledger = { counts: Record<WorkItemState, number>; items: WorkItem[] };

describe('GET /api/work-items', () => {
  it('counts each item once, in the state its newest job put it: a failure handed to a person needs you', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
    apps.push(a);
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    await a.waitForStatus(job.id, 'failed');
    const ledger = await waitFor(async () => {
      const r = (await a.api<Ledger>('GET', '/api/work-items')).body;
      return r.counts.needs_you === 1 ? r : undefined;
    }, { what: 'the item handed to a person in the ledger' });
    expect(ledger.items).toEqual([expect.objectContaining({ key: job.source!.key, state: 'needs_you', waitingOn: 'a hand-off', failedJobId: job.id })]);
    expect(Object.values(ledger.counts).reduce((s, n) => s + n, 0)).toBe(1);
    expect((await a.api<Ledger>('GET', '/api/work-items?state=done')).body.items).toEqual([]);
    expect((await a.api('GET', '/api/work-items?state=nope')).status).toBe(400);
  });
});

type Queue = { locked: Job[]; items: Record<WorkItemState, number>; inFlight: number };

describe('every view reads the ledger (issue #1067, part 2)', () => {
  it('Failures, the queue and the job graph count one failure as the ledger does, and none once it is dismissed', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
    apps.push(a);
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    await a.waitForStatus(job.id, 'failed');
    await waitFor(async () => ((await a.api<Ledger>('GET', '/api/work-items')).body.counts.needs_you === 1 ? true : undefined), { what: 'handed to a person' });

    // Handed to a person: it needs you, and no view counts it as failed.
    const failures = (await a.api<FailuresView>('GET', '/api/failures')).body;
    expect(failures.counts).toEqual({ failed: 0, needsPerson: 1 });
    const queue = (await a.api<Queue>('GET', '/api/queue')).body;
    expect(queue.items).toMatchObject({ failed: 0, needs_you: 1 });
    expect(queue.locked.map((j) => j.id)).toEqual([job.id]);
    const graph = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    expect(graph.stages.failed).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === `job:${job.id}`)).toMatchObject({ stage: 'waiting', waitsOnYou: true });

    // Dismissed: dropped in the ledger, and gone from every count and from the locked entries.
    expect((await a.ui(`/ui/api/jobs/${job.id}/dismiss`, {}, { token })).status).toBe(200);
    const ledger = (await a.api<Ledger>('GET', '/api/work-items')).body;
    expect(ledger.counts).toMatchObject({ failed: 0, needs_you: 0, dropped: 1 });
    expect((await a.api<FailuresView>('GET', '/api/failures')).body.counts).toEqual({ failed: 0, needsPerson: 0 });
    const after = (await a.api<Queue>('GET', '/api/queue')).body;
    expect(after.items).toEqual(ledger.counts);
    expect(after.locked).toEqual([]);
    const graphAfter = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    expect(graphAfter.stages.failed).toBeUndefined();
  });
});

describe('in flight (issue #1113)', () => {
  it('GET /api/queue counts the work items in flight as the ledger holds them: a job at work, none once it failed', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
    apps.push(a);
    expect((await a.api<Queue>('GET', '/api/queue')).body.inFlight).toBe(0);
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    await a.waitForStatus(job.id, 'running');
    const working = await waitFor(async () => {
      const r = (await a.api<Ledger>('GET', '/api/work-items?state=working')).body;
      return r.counts.working === 1 ? r : undefined;
    }, { what: 'the item at work in the ledger' });
    expect((await a.api<Queue>('GET', '/api/queue')).body.inFlight).toBe(working.items.length);
    const graph = (await a.api<JobGraph>('GET', '/api/jobs/graph')).body;
    expect(graph.nodes.find((n) => n.id === `job:${job.id}`)).toMatchObject({ inFlight: true });

    const failed = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    await a.waitForStatus(failed.id, 'failed');
    await waitFor(async () => ((await a.api<Ledger>('GET', '/api/work-items')).body.counts.needs_you === 1 ? true : undefined), { what: 'handed to a person' });
    expect((await a.api<Queue>('GET', '/api/queue')).body.inFlight).toBe(1);
  });
});
