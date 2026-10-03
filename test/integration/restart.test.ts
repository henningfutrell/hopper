// Persistence across a restart: two app instances over one SQLite file and one manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeWebhooksFile } from '../support/files.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

describe('persistence across restart', () => {
  it('requeues the interrupted job, keeps queued jobs, file webhooks and the Jev mode, and never re-ingests an item', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    writeWebhooksFile(db.dbPath, [{ name: 'h', url: 'http://127.0.0.1:9/h', events: ['lane.opened'], secret: 's' }]);
    const source = createManualSource();
    const env = { JOB_HOPPER_LOCAL_LANES: '1' };
    const first = await startTestApp({ dbPath: db.dbPath, env, source });
    apps.push(first);
    expect((await first.ui('/ui/api/jev', { mode: 'active' }, { token: await first.login() })).status).toBe(200);
    const hook = (await first.api('GET', '/api/webhooks')).body.subscriptions[0];
    const running = await first.pull({ op: 'sleep', ms: 1500 });
    await first.waitForStatus(running.id, 'running');
    const queued = await first.pull({ op: 'echo' });
    await first.waitForStatus(queued.id, 'held');
    await first.stop();

    const second = await startTestApp({ dbPath: db.dbPath, env: { ...env, JOB_HOPPER_JEV_MODE: 'shadow' }, source });
    apps.push(second);
    expect((await second.api('GET', '/api/jev')).body.mode).toBe('active');
    expect((await second.api('GET', '/api/webhooks')).body.subscriptions.map((s: { id: string; name: string }) => [s.id, s.name])).toEqual([[hook.id, 'h']]);
    const requeued = await waitFor(async () => (await second.events()).find((e) => e.type === 'job.requeued' && e.jobId === running.id));
    expect(requeued.data).toMatchObject({ from: 'running' });
    expect((await second.events()).find((e) => e.type === 'lane.closed' && e.data.reason === 'daemon restart')).toBeDefined();
    expect((await second.waitForStatus(running.id, 'finished', 8000)).attempts).toBe(2);
    await second.waitForStatus(queued.id, 'finished', 8000);
    await second.sync();
    const jobs = (await second.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs.map((j) => j.id).sort()).toEqual([running.id, queued.id].sort());
  });
});
