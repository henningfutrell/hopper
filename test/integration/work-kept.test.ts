// The reap at a job's end (issue #401): what it kept for uncommitted or unpushed work is flagged on the
// job's trail as job.work_kept, never removed silently; a reap that kept nothing records nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createStickyExecutor } from '../support/doubles.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let app: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  cleanup?.();
});

async function cancelled(kept?: string[], removed?: { containers: string[]; volumes: string[] }) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const sticky = createStickyExecutor({ ...(kept ? { kept } : {}), ...(removed ? { removed } : {}) });
  app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [sticky] } });
  const job = await app.pull({}, { executor: 'sticky' });
  await app.waitForStatus(job.id, 'running');
  expect((await app.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await app.login() })).status).toBe(200);
  await app.waitForStatus(job.id, 'cancelled');
  await waitFor(() => sticky.cleaned.includes(job.id));
  return { a: app, job };
}

describe('work the reap kept (issue #401)', () => {
  it('flags each kept repository on the job: job.work_kept with its paths', async () => {
    const { a, job } = await cancelled(['/w/.hopper-scratch/j/repo']);
    await waitFor(async () => (await a.events('types=job.work_kept')).length === 1);
    const [e] = await a.events('types=job.work_kept');
    expect(e).toMatchObject({ jobId: job.id, data: { paths: ['/w/.hopper-scratch/j/repo'] } });
  });

  it('records nothing when the reap kept nothing', async () => {
    const { a } = await cancelled([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.work_kept')).toEqual([]);
  });
});

describe('the containers and volumes the reap removed (issue #1120)', () => {
  it('are recorded on the job: job.containers_removed with each one', async () => {
    const { a, job } = await cancelled(undefined, { containers: ['c0ffee01'], volumes: ['vol-db'] });
    await waitFor(async () => (await a.events('types=job.containers_removed')).length === 1);
    const [e] = await a.events('types=job.containers_removed');
    expect(e).toMatchObject({ jobId: job.id, data: { containers: ['c0ffee01'], volumes: ['vol-db'] } });
  });

  it('records nothing when it removed none', async () => {
    const { a } = await cancelled(undefined, { containers: [], volumes: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.containers_removed')).toEqual([]);
  });
});
