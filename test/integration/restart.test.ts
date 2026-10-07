// Persistence across a restart: two app instances over one database and one manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeWebhooks } from '../support/files.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

describe('persistence across restart', () => {
  it('requeues the interrupted job, keeps queued jobs and file webhooks, and never re-ingests an item', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    writeWebhooks(db.dbPath, [{ name: 'h', url: 'http://127.0.0.1:9/h', events: ['lane.opened'], secretEnv: 'WEBHOOK_SECRET_H' }]);
    const source = createManualSource();
    const first = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) }, source });
    apps.push(first);
    const hook = (await first.api('GET', '/api/webhooks')).body.subscriptions[0];
    const running = await first.pull({ op: 'sleep', ms: 1500 });
    await first.waitForStatus(running.id, 'running');
    const queued = await first.pull({ op: 'echo' });
    await waitFor(async () => (await first.job(queued.id)).waitReason !== undefined, { what: 'the second job waiting for a lane' });
    await first.stop();

    const second = await startTestApp({ dbPath: db.dbPath, source });
    apps.push(second);
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
