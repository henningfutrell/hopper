// Shadow mode exists to measure Jev. A job that starts before Jev answers must still have
// its advice recorded, or shadow mode measures only the jobs that happened to wait.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

describe('Jev advice that arrives after the job left the queue', () => {
  let t: TestApp | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    await t?.stop();
    cleanup?.();
  });

  it('is still recorded on the job and emitted as job.prioritized (real router, shadow)', async () => {
    const tmp = tempDbPath();
    cleanup = tmp.cleanup;
    t = await startTestApp({ dbPath: tmp.dbPath, env: { JOB_HOPPER_JEV_ADVISOR: 'router' } });

    const job = await t.pull({ op: 'echo', message: 'fast' }, { title: 'say hi' });
    const done = await t.waitForStatus(job.id, 'finished');
    expect(done.jevAdvice).toBeUndefined(); // the python spawn is slower than an echo job

    const advised = await waitFor(async () => (await t!.job(job.id)).jevAdvice, { timeoutMs: 10000, what: 'late advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', source: 'jev-router', jevUsed: false });
    const prioritized = (await t.events('types=job.prioritized')).filter((e) => e.jobId === job.id);
    expect(prioritized).toHaveLength(1);
    expect(prioritized[0]!.data).toMatchObject({ mode: 'shadow', statusAtAdvice: 'finished' });
  });

  it('reaches every job pulled in a burst, even ones a Decision claimed before any sweep', async () => {
    const tmp = tempDbPath();
    cleanup = tmp.cleanup;
    t = await startTestApp({ dbPath: tmp.dbPath, env: { JOB_HOPPER_JEV_ADVISOR: 'router' } });

    for (let i = 0; i < 8; i++) t.source.add(manualItem({ prompt: JSON.stringify({ op: 'echo', message: `burst ${i}` }), priority: 10 * i }));
    await t.sync();
    const jobs = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs).toHaveLength(8);
    for (const job of jobs) await t.waitForStatus(job.id, 'finished');

    await waitFor(async () => {
      const all = await Promise.all(jobs.map((j) => t!.job(j.id)));
      return all.every((j) => j.jevAdvice?.source === 'jev-router');
    }, { timeoutMs: 12000, what: 'advice on every burst job' });
  });
});
