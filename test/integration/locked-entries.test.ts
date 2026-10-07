// Issue #355: a failed job goes back to the queue as a locked entry. It is never run by itself, takes
// no lane, and stays until it is run again (Run again: a new job through the normal queue, issue #354)
// or dismissed. Real daemon, the manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { QueueView } from '../../src/engine/queries.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

const queue = async (a: TestApp): Promise<QueueView> => (await a.api<QueueView>('GET', '/api/queue')).body;

/** A job that failed, its failure reported to its source: what Run again takes. */
async function failedJob(a: TestApp, item: Parameters<TestApp['pull']>[1] = {}, message = 'it broke'): Promise<Job> {
  const job = await a.pull({ op: 'fail', message }, item);
  await a.waitForStatus(job.id, 'failed');
  await waitFor(async () => (await a.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'the failure reported' });
  return a.job(job.id);
}

describe('a failed job is a locked entry in the queue', () => {
  it('a failed job is listed as locked, with its failure, and holds no lane', async () => {
    const a = await boot();
    const failed = await failedJob(a, { priority: 70 });
    const q = await queue(a);
    expect(q.locked.map((j) => j.id)).toEqual([failed.id]);
    expect(q.locked[0]).toMatchObject({ status: 'failed', error: 'it broke', priority: 70 });
    expect(q.waiting).toEqual([]);
    expect(q.running).toEqual([]);
  });

  it('locked entries are in priority order, highest first', async () => {
    const a = await boot();
    const low = await failedJob(a, { priority: 20 });
    const high = await failedJob(a, { priority: 90 });
    expect((await queue(a)).locked.map((j) => j.id)).toEqual([high.id, low.id]);
  });

  it('Run again on a locked entry unlocks it: the new job goes through the queue, linked to it', async () => {
    const a = await boot();
    const token = await a.login();
    const failed = await failedJob(a);
    const r = await a.ui<Job>(`/ui/api/jobs/${failed.id}/rerun`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rerunOf: failed.id });
    expect((await queue(a)).locked.map((j) => j.id)).not.toContain(failed.id);
    // The new attempt failed again: it is the locked entry now, the earlier one is history.
    await a.waitForStatus(r.body.id, 'failed');
    await waitFor(async () => (await queue(a)).locked.map((j) => j.id).join() === r.body.id, { what: 'the new attempt locked' });
  });

  it('Dismiss takes a locked entry out of the queue; the job stays failed and can still run again', async () => {
    const a = await boot();
    const token = await a.login();
    const failed = await failedJob(a);
    const r = await a.ui<Job>(`/ui/api/jobs/${failed.id}/dismiss`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: failed.id, status: 'failed', dismissedAt: expect.any(String) });
    expect((await queue(a)).locked).toEqual([]);
    expect((await a.events('types=job.dismissed')).map((e) => [e.jobId, e.data])).toEqual([[failed.id, { by: 'user' }]]);
    expect((await a.ui(`/ui/api/jobs/${failed.id}/dismiss`, {}, { token })).status).toBe(409);
    expect((await a.ui(`/ui/api/jobs/${failed.id}/rerun`, {}, { token })).status).toBe(200);
  });

  it('only a failed job can be dismissed', async () => {
    const a = await boot();
    const token = await a.login();
    const done = await a.pull({ op: 'echo' });
    await a.waitForStatus(done.id, 'finished');
    expect((await a.ui(`/ui/api/jobs/${done.id}/dismiss`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/jobs/nope/dismiss', {}, { token })).status).toBe(404);
  });
});
