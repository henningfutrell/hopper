// The reap at a job's end (issue #401): what it kept for uncommitted or unpushed work is flagged on the
// job's trail as job.work_kept, never removed silently; a reap that kept nothing records nothing. What the job's scope
// used (issue #2498) is recorded as job.resources_used.
import { afterEach, describe, expect, it } from 'vitest';
import type { Reaped } from '../../src/domain/ports.ts';
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

async function cancelled(kept?: string[], removed?: Reaped['removed'], tips?: Reaped['tips'], heads?: string[], used?: Reaped['used']) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const sticky = createStickyExecutor({ ...(kept ? { kept } : {}), ...(tips ? { tips } : {}), ...(removed ? { removed } : {}), ...(used ? { used } : {}) });
  app = await startTestApp({ dbPath: db.dbPath, source: createManualSource(), seams: { executors: [sticky] } });
  const job = await app.pull({}, { executor: 'sticky' });
  await app.waitForStatus(job.id, 'running');
  // Its push through the hopper (issue #2087): the commits it moved its branch to.
  if (heads) app.user().store.events.append({ type: 'github_proxy.done', jobId: job.id, data: { requestId: 'r1', op: 'git.push', repo: 'o/r', refs: ['refs/heads/x'], heads } });
  expect((await app.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token: await app.login() })).status).toBe(200);
  await app.waitForStatus(job.id, 'cancelled');
  await waitFor(() => sticky.cleaned.includes(job.id));
  return { a: app, job };
}

describe('work the reap kept (issue #401)', () => {
  it('flags each kept repository on the job: job.work_kept with its paths', async () => {
    const { a, job } = await cancelled(['/w/.worktrees/@scratch/j/repo']);
    await waitFor(async () => (await a.events('types=job.work_kept')).length === 1);
    const [e] = await a.events('types=job.work_kept');
    expect(e).toMatchObject({ jobId: job.id, data: { paths: ['/w/.worktrees/@scratch/j/repo'] } });
  });

  it('records nothing when each tip of the kept work is a commit the hopper pushed for the job (issue #2087)', async () => {
    const repo = '/w/.worktrees/@scratch/j/repo';
    const { a } = await cancelled([repo], undefined, { [repo]: ['c0ffee'] }, ['c0ffee']);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.work_kept')).toEqual([]);
  });

  it('flags it when a tip is one the hopper did not push (issue #2087)', async () => {
    const repo = '/w/.worktrees/@scratch/j/repo';
    const { a } = await cancelled([repo], undefined, { [repo]: ['c0ffee', 'beef'] }, ['c0ffee']);
    await waitFor(async () => (await a.events('types=job.work_kept')).length === 1);
  });

  it('records nothing when the reap kept nothing', async () => {
    const { a } = await cancelled([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.work_kept')).toEqual([]);
  });
});

describe('the containers and volumes the reap removed (issue #1120)', () => {
  it('are recorded on the job: job.containers_removed with each one', async () => {
    const details = [{ id: 'c0ffee01', name: 'db-1', image: 'postgres:16', startedAt: '2026-10-01T00:05:00.000Z' }];
    const { a, job } = await cancelled(undefined, { containers: ['c0ffee01'], volumes: ['vol-db'], details });
    await waitFor(async () => (await a.events('types=job.containers_removed')).length === 1);
    const [e] = await a.events('types=job.containers_removed');
    expect(e).toMatchObject({ jobId: job.id, data: { containers: ['c0ffee01'], volumes: ['vol-db'], details } });
  });

  it('records nothing when it removed none', async () => {
    const { a } = await cancelled(undefined, { containers: [], volumes: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.containers_removed')).toEqual([]);
  });
});

describe('what the job\'s scope used (issue #2498)', () => {
  it('is recorded on the job: job.resources_used with its machine', async () => {
    const used = { memoryPeakBytes: 3221225472, cpuSeconds: 754.5, oomKills: 1 };
    const { a, job } = await cancelled(undefined, undefined, undefined, undefined, used);
    await waitFor(async () => (await a.events('types=job.resources_used')).length === 1);
    const [e] = await a.events('types=job.resources_used');
    expect(e).toMatchObject({ jobId: job.id, data: used });
  });

  it('records nothing when the reap read none', async () => {
    const { a } = await cancelled([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await a.events('types=job.resources_used')).toEqual([]);
  });
});
