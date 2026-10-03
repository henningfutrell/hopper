import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

describe('persistence across restart', () => {
  it('requeues the interrupted job, keeps queued jobs, webhooks and the Jev mode', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const env = { JOB_HOPPER_LOCAL_LANES: '1' };
    const first = await startTestApp({ dbPath: db.dbPath, env });
    apps.push(first);
    await first.api('PUT', '/api/jev', { mode: 'active' });
    const hook = (await first.api('POST', '/api/webhooks', { url: 'http://127.0.0.1:9/h', events: ['lane.opened'] })).body;
    const running = await first.push({ executor: 'test', payload: { op: 'sleep', ms: 1500 } });
    await first.waitForStatus(running.id, 'running');
    const queued = await first.push({ executor: 'test', payload: { op: 'echo' } });
    await first.waitForStatus(queued.id, 'held');
    await first.stop();

    const second = await startTestApp({ dbPath: db.dbPath, env: { ...env, JOB_HOPPER_JEV_MODE: 'shadow' } });
    apps.push(second);
    expect((await second.api('GET', '/api/jev')).body.mode).toBe('active');
    expect((await second.api('GET', '/api/webhooks')).body.subscriptions.map((s: { id: string }) => s.id)).toEqual([hook.id]);
    const requeued = await waitFor(async () => (await second.events()).find((e) => e.type === 'job.requeued' && e.jobId === running.id));
    expect(requeued.data).toMatchObject({ from: 'running' });
    const restartClose = (await second.events()).find((e) => e.type === 'lane.closed' && e.data.reason === 'daemon restart');
    expect(restartClose).toBeDefined();
    const done = await second.waitForStatus(running.id, 'finished', 8000);
    expect(done.attempts).toBe(2);
    await second.waitForStatus(queued.id, 'finished', 8000);
  });
});
