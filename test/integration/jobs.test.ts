// Jobs pulled from a source, run, and read back over the read-only API.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp;
let cleanup: () => void;

beforeEach(async () => {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
});
afterEach(async () => {
  await t.stop();
  cleanup();
});

const typesFor = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId).map((e) => e.type);

describe('jobs pulled from a source', () => {
  it('an item becomes one queued job with the source spec, its source ref, and a clamped priority', async () => {
    const job = await t.pull({ op: 'echo', message: 'hi' }, { title: 'Say hi', author: 'owner', priority: 500, cwd: '/tmp/w', env: { HOPPER_X: '1' } });
    expect(job).toMatchObject({ priority: 100, approved: false });
    expect(job.spec).toEqual({
      executor: 'scripted', payload: { prompt: '{"op":"echo","message":"hi"}', body: 'body', cwd: '/tmp/w', env: { HOPPER_X: '1' } },
      priority: 100, goal: 'Say hi', submittedBy: 'manual:owner', kind: 'coding',
    });
    expect(job.source).toMatchObject({ source: 'manual', kind: 'manual', key: expect.any(String), title: 'Say hi', author: 'owner' });
    expect((await t.pull({ op: 'echo' }, { priority: -3 })).priority).toBe(0);
    const queued = (await t.events('types=job.queued')).find((e) => e.jobId === job.id)!;
    expect(queued.data).toEqual({ spec: job.spec, priority: 100, source: job.source });
  });

  it('dedupes by source key: syncing again creates no second job', async () => {
    const job = await t.pull({ op: 'echo' });
    await t.sync();
    await t.sync();
    const jobs = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs.filter((j) => j.source?.key === job.source!.key)).toHaveLength(1);
  });

  it('an item the executor rejects, or one marked invalid, is created and failed at once', async () => {
    const bad = await t.pull({ op: 'dance' });
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatch(/invalid payload for executor scripted: op must be/);
    const unknown = await t.pull({ op: 'echo' }, { executor: 'nope' });
    expect(unknown.error).toMatch(/unknown executor nope/);
    const empty = await t.pull({ op: 'echo' }, { invalid: 'empty issue body' });
    expect(empty).toMatchObject({ status: 'failed', error: 'empty issue body' });
    expect(typesFor(await t.events(), empty.id).slice(0, 2)).toEqual(['job.queued', 'job.failed']);
    await waitFor(() => t.source.reports.some((r) => r.kind === 'failed' && r.job.id === empty.id), { what: 'failed report' });
    expect(t.source.reports.filter((r) => r.job.id === empty.id).map((r) => r.kind)).toEqual(['claimed', 'failed']);
  });

  it('get and list jobs, newest first, filtered by status; 404 for an unknown id', async () => {
    const a = await t.pull({ op: 'echo' });
    const b = await t.pull({ op: 'echo' });
    expect((await t.api('GET', `/api/jobs/${a.id}`)).body.id).toBe(a.id);
    expect((await t.api('GET', '/api/jobs/missing')).status).toBe(404);
    const list = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=2')).body.jobs;
    expect(list.map((j) => j.id)).toEqual([b.id, a.id]);
    await t.waitForStatus(a.id, 'finished');
    await t.waitForStatus(b.id, 'finished');
    expect((await t.api<{ jobs: Job[] }>('GET', '/api/jobs?status=queued,held')).body.jobs).toEqual([]);
    expect((await t.api('GET', '/api/jobs?status=bogus')).status).toBe(400);
  });

  it('a sleep job runs to finished with the full event sequence, and the source hears claimed then finished', async () => {
    const job = await t.pull({ op: 'sleep', ms: 200 });
    const done = await t.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ slept: 200 });
    expect(done.attempts).toBe(1);
    const events = await waitFor(async () => {
      const ev = await t.events();
      return ev.some((e) => e.type === 'job.prioritized' && e.jobId === job.id) ? ev : undefined;
    });
    const types = typesFor(events, job.id);
    expect(types[0]).toBe('job.queued');
    for (const ty of ['job.prioritized', 'job.claimed', 'job.started', 'job.progressed', 'job.finished']) expect(types).toContain(ty);
    expect(types.indexOf('job.claimed')).toBeLessThan(types.indexOf('job.started'));
    expect(types.lastIndexOf('job.progressed')).toBeLessThan(types.indexOf('job.finished'));
    const claimed = events.find((e) => e.type === 'job.claimed' && e.jobId === job.id)!;
    const made = events.find((e) => e.type === 'decision.made' && (e.data.starts as { jobId: string }[]).some((s) => s.jobId === job.id))!;
    expect(made.decisionId).toBe(made.data.decisionId);
    const opened = events.find((e) => e.type === 'lane.opened' && e.laneId === claimed.laneId)!;
    expect(opened.machineId).toBe('local');
    expect(made.seq).toBeLessThan(opened.seq);
    const kinds = await waitFor(() => {
      const k = t.source.reports.filter((r) => r.job.id === job.id).map((r) => r.kind);
      return k.includes('finished') ? k : undefined;
    }, { what: 'finished report' });
    expect(kinds[0]).toBe('claimed');
    expect(kinds.at(-1)).toBe('finished');
    expect((await t.job(job.id)).sourceState).toMatchObject({ sync: { claimReported: true, finalReported: true } });
  });

  it('a fail job ends failed with its error', async () => {
    const job = await t.pull({ op: 'fail', message: 'boom' });
    expect((await t.waitForStatus(job.id, 'failed')).error).toBe('boom');
  });

  it('Retry gives a failed job back to its source: the item is offered again and a new job runs (issue #313)', async () => {
    const token = await t.login();
    const failed = await t.pull({ op: 'fail', message: 'scratch dir timed out' });
    await t.waitForStatus(failed.id, 'failed');
    await waitFor(async () => (await t.job(failed.id)).sourceState?.sync?.finalReported === true, { what: 'the failure reported' });
    await t.sync();
    const jobsFor = async () => (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === failed.source?.key);
    expect(await jobsFor()).toHaveLength(1); // ended and reported: not offered again on its own

    const r = await t.ui<Job>(`/ui/api/jobs/${failed.id}/retry`, {}, { token });
    expect(r.status).toBe(200);
    expect(t.source.reports.filter((x) => x.job.id === failed.id).map((x) => x.kind)).toEqual(['claimed', 'failed', 'retried']);
    expect((await t.events('types=job.retried')).find((e) => e.jobId === failed.id)?.data).toEqual({ by: 'user' });
    await waitFor(async () => (await jobsFor()).length === 2, { what: 'the new job' });
  });

  it('Retry refuses a job that has not failed (409) and an unknown one (404)', async () => {
    const token = await t.login();
    const long = await t.pull({ op: 'sleep', ms: 10000 });
    await t.waitForStatus(long.id, 'running');
    expect((await t.ui(`/ui/api/jobs/${long.id}/retry`, {}, { token })).status).toBe(409);
    expect((await t.ui('/ui/api/jobs/nope/retry', {}, { token })).status).toBe(404);
    expect(await t.events('types=job.retried')).toEqual([]);
  });

  it('a cancel signal from the source cancels a running job with the source reason', async () => {
    const long = await t.pull({ op: 'sleep', ms: 10000 });
    await t.waitForStatus(long.id, 'running');
    t.source.signal({ kind: 'cancel', jobId: long.id, reason: 'issue closed' });
    await t.sync();
    const ended = await t.waitForStatus(long.id, 'cancelled', 2000);
    expect(ended.finishedAt).toBeDefined();
    const cancelled = (await t.events()).find((e) => e.type === 'job.cancelled' && e.jobId === long.id)!;
    expect(cancelled.data).toEqual({ reason: 'issue closed' });
    await waitFor(() => t.source.reports.some((r) => r.kind === 'cancelled' && r.job.id === long.id));
  });

  it('the queue orders waiting jobs by priority, then age; it carries the jobs, not counts of them', async () => {
    t.setUsage(99);
    const low = await t.pull({ op: 'echo' }, { priority: 10 });
    const high = await t.pull({ op: 'echo' }, { priority: 90 });
    const mid = await t.pull({ op: 'echo' });
    const queue = (await t.api('GET', '/api/queue')).body;
    expect(queue.waiting.map((j: Job) => j.id)).toEqual([high.id, mid.id, low.id]);
    expect(queue.running).toEqual([]);
    expect(queue.counts).toBeUndefined();
    expect(queue.waitingAnswer).toEqual([]);
  });

  it('the queue lists ended jobs (finished, failed, cancelled), newest end first, never a live one', async () => {
    const done = await t.pull({ op: 'echo' }, { key: 'ended-1' });
    await t.waitForStatus(done.id, 'finished');
    const bad = await t.pull({ op: 'fail', message: 'boom' }, { key: 'ended-2' });
    await t.waitForStatus(bad.id, 'failed');
    const long = await t.pull({ op: 'sleep', ms: 10000 }, { key: 'ended-3' });
    await t.waitForStatus(long.id, 'running');
    const queue = (await t.api('GET', '/api/queue')).body;
    // The manual source offers a failed item again (re-run), so more than one job may end on ended-2.
    const ended: Job[] = queue.ended;
    const ids = ended.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([done.id, bad.id]));
    expect(ids).not.toContain(long.id);
    expect(ended.every((j) => ['finished', 'failed', 'cancelled'].includes(j.status))).toBe(true);
    const ends = ended.map((j) => j.finishedAt!);
    expect(ends).toEqual([...ends].sort().reverse());
    expect(ids.indexOf(bad.id)).toBeLessThan(ids.indexOf(done.id));
    expect(queue.running.map((j: Job) => j.id)).toEqual([long.id]);
  });

  it('the ended list holds every job that ended in the last 24 hours, and none older (issue #45)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const j = await t.pull({ op: 'echo' }, { key: `window-${i}` });
      await t.waitForStatus(j.id, 'finished');
      ids.push(j.id);
    }
    // Age the first one past the window, as the store would hold it a day later.
    t.user().store.jobs.update(ids[0]!, { finishedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    const ended = (await t.api('GET', '/api/queue')).body.ended.map((j: Job) => j.id);
    expect(ended).toEqual(ids.slice(1).reverse());
  });

  it('re-sorting: a changed item priority reprioritizes a waiting job (job.reprioritized), never a running one', async () => {
    t.setUsage(100);
    const waiting = await t.pull({ op: 'echo' }, { key: 'resort-1', priority: 40 });
    t.source.add(manualItem({ key: 'resort-1', prompt: '{"op":"echo"}', priority: 80, priorityReason: 'label:hopper:high' }));
    await t.sync();
    expect((await t.job(waiting.id)).priority).toBe(80);
    const ev = (await t.events('types=job.reprioritized')).filter((e) => e.jobId === waiting.id);
    expect(ev.map((e) => e.data)).toEqual([{ from: 40, to: 80, reason: 'label:hopper:high' }]);
    await t.sync();
    expect((await t.events('types=job.reprioritized')).filter((e) => e.jobId === waiting.id)).toHaveLength(1);

    t.setUsage(0);
    const running = await t.pull({ op: 'sleep', ms: 5000 }, { key: 'resort-2', priority: 30 });
    await t.waitForStatus(running.id, 'running');
    t.source.add(manualItem({ key: 'resort-2', prompt: '{"op":"sleep","ms":5000}', priority: 90 }));
    await t.sync();
    expect((await t.job(running.id)).priority).toBe(30);
  });

  it('serves health', async () => {
    const health = (await t.api('GET', '/api/health')).body;
    expect(health).toMatchObject({ ok: true, router: 'fake', fallback: false });
    expect(health).not.toHaveProperty('routerMode');
    expect(health).not.toHaveProperty('advisor');
    expect(health.executors).toEqual(['test', 'scripted']);
    const missing = await t.api('GET', '/api/nothing');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeDefined();
  });
});
