import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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

describe('jobs over HTTP', () => {
  it('push returns 201 with the job, defaulting and clamping priority', async () => {
    const res = await t.api<Job>('POST', '/api/jobs', { executor: 'test', payload: { op: 'echo', message: 'hi' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'queued', priority: 50, approved: false, attempts: 0 });
    expect((await t.push({ executor: 'test', payload: { op: 'echo' }, priority: 500 })).priority).toBe(100);
    expect((await t.push({ executor: 'test', payload: { op: 'echo' }, priority: -3 })).priority).toBe(0);
  });

  it('rejects an unknown executor, a payload the executor refuses, and a malformed body with 400', async () => {
    const unknown = await t.api('POST', '/api/jobs', { executor: 'nope', payload: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/executor/);
    const badOp = await t.api('POST', '/api/jobs', { executor: 'test', payload: { op: 'dance' } });
    expect(badOp.status).toBe(400);
    expect(badOp.body.error).toMatch(/op must be/);
    expect((await t.api('POST', '/api/jobs', { payload: {} })).status).toBe(400);
    expect((await t.api('POST', '/api/jobs', { executor: 'test', payload: 'x' })).status).toBe(400);
  });

  it('get and list jobs, newest first, filtered by status; 404 for an unknown id', async () => {
    const a = await t.push({ executor: 'test', payload: { op: 'echo' } });
    const b = await t.push({ executor: 'test', payload: { op: 'echo' } });
    expect((await t.api('GET', `/api/jobs/${a.id}`)).body.id).toBe(a.id);
    expect((await t.api('GET', '/api/jobs/missing')).status).toBe(404);
    const list = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=2')).body.jobs;
    expect(list.map((j) => j.id)).toEqual([b.id, a.id]);
    await t.waitForStatus(a.id, 'finished');
    await t.waitForStatus(b.id, 'finished');
    expect((await t.api<{ jobs: Job[] }>('GET', '/api/jobs?status=queued,held')).body.jobs).toEqual([]);
    expect((await t.api('GET', '/api/jobs?status=bogus')).status).toBe(400);
  });

  it('an echo job runs to finished with the full event sequence', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'sleep', ms: 200 } });
    const done = await t.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ slept: 200 });
    expect(done.attempts).toBe(1);
    expect(done.startedAt).toBeDefined();
    const events = await waitFor(async () => {
      const ev = await t.events();
      return ev.some((e) => e.type === 'job.prioritized' && e.jobId === job.id) ? ev : undefined;
    });
    const types = typesFor(events, job.id);
    expect(types[0]).toBe('job.queued');
    for (const ty of ['job.prioritized', 'job.claimed', 'job.started', 'job.progressed', 'job.finished']) {
      expect(types).toContain(ty);
    }
    expect(types.indexOf('job.claimed')).toBeLessThan(types.indexOf('job.started'));
    expect(types.indexOf('job.started')).toBeLessThan(types.indexOf('job.progressed'));
    expect(types.lastIndexOf('job.progressed')).toBeLessThan(types.indexOf('job.finished'));
    expect(types.filter((x) => x === 'job.progressed').length).toBeLessThanOrEqual(2);
    const claimed = events.find((e) => e.type === 'job.claimed' && e.jobId === job.id)!;
    const made = events.find((e) => e.type === 'decision.made'
      && (e.data.starts as { jobId: string }[]).some((s) => s.jobId === job.id))!;
    expect(made.decisionId).toBe(made.data.decisionId);
    expect(made.data).toMatchObject({ jevMode: 'shadow' });
    expect(made.data).toHaveProperty('trigger');
    const opened = events.find((e) => e.type === 'lane.opened' && e.laneId === claimed.laneId)!;
    expect(opened.machineId).toBe('local');
    expect(opened.seq).toBeLessThan(claimed.seq);
    expect(made.seq).toBeLessThan(opened.seq);
  });

  it('a fail job ends failed with its error', async () => {
    const job = await t.push({ executor: 'test', payload: { op: 'fail', message: 'boom' } });
    const failed = await t.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe('boom');
    expect(typesFor(await t.events(), job.id)).toContain('job.failed');
  });

  it('cancels a waiting job at once and a running job by aborting it; terminal is 409', async () => {
    await t.api('PUT', '/api/usage/fake', { used: 100, limit: 100 });
    const waiting = await t.push({ executor: 'test', payload: { op: 'echo' } });
    const cancelled = await t.api<Job>('POST', `/api/jobs/${waiting.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await t.api('POST', `/api/jobs/${waiting.id}/cancel`)).status).toBe(409);
    expect((await t.api('POST', '/api/jobs/missing/cancel')).status).toBe(404);

    await t.api('PUT', '/api/usage/fake', { used: 0, limit: 100 });
    const long = await t.push({ executor: 'test', payload: { op: 'sleep', ms: 10000 } });
    await t.waitForStatus(long.id, 'running');
    expect((await t.api('POST', `/api/jobs/${long.id}/cancel`)).status).toBe(200);
    const ended = await t.waitForStatus(long.id, 'cancelled', 2000);
    expect(ended.finishedAt).toBeDefined();
    expect(typesFor(await t.events(), long.id)).toContain('job.cancelled');
    expect((await t.api('POST', `/api/jobs/${long.id}/approve`)).status).toBe(409);
    expect((await t.api('POST', '/api/jobs/missing/approve')).status).toBe(404);
  });

  it('the queue orders waiting jobs by priority, then age, and counts every status', async () => {
    await t.api('PUT', '/api/usage/fake', { used: 99, limit: 100 });
    const low = await t.push({ executor: 'test', payload: { op: 'echo' }, priority: 10 });
    const high = await t.push({ executor: 'test', payload: { op: 'echo' }, priority: 90 });
    const mid = await t.push({ executor: 'test', payload: { op: 'echo' } });
    const queue = (await t.api('GET', '/api/queue')).body;
    expect(queue.waiting.map((j: Job) => j.id)).toEqual([high.id, mid.id, low.id]);
    expect(queue.running).toEqual([]);
    expect(queue.counts.queued + queue.counts.held).toBe(3);
    expect(Object.keys(queue.counts).sort()).toEqual(
      ['cancelled', 'claimed', 'failed', 'finished', 'held', 'queued', 'running', 'waiting_answer']);
    expect(queue.waitingAnswer).toEqual([]);
  });

  it('serves health and the UI', async () => {
    const health = (await t.api('GET', '/api/health')).body;
    expect(health).toMatchObject({ ok: true, jevMode: 'shadow', advisor: 'fake' });
    expect(typeof health.version).toBe('string');
    expect(typeof health.uptimeS).toBe('number');
    expect(health.executors).toEqual(['test']);
    const page = await fetch(t.url + '/');
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('/ui/app.js');
    expect((await fetch(t.url + '/ui/app.js')).headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(t.url + '/ui/style.css')).headers.get('content-type')).toMatch(/text\/css/);
    const missing = await t.api('GET', '/api/nothing');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeDefined();
  });
});
