// Shadow mode exists to measure Jev. A job that starts before Jev answers must still have
// its advice recorded, or shadow mode measures only the jobs that happened to wait.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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

    const job = await t.push({ executor: 'test', payload: { op: 'echo', message: 'fast' }, goal: 'say hi', kind: 'chat' });
    const done = await t.waitForStatus(job.id, 'finished');
    expect(done.jevAdvice).toBeUndefined(); // the python spawn is slower than an echo job

    const advised = await waitFor(async () => (await t!.job(job.id)).jevAdvice, { timeoutMs: 10000, what: 'late advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', source: 'jev-router', jevUsed: false });
    const prioritized = (await t.events('types=job.prioritized')).filter((e) => e.jobId === job.id);
    expect(prioritized).toHaveLength(1);
    expect(prioritized[0]!.data).toMatchObject({ mode: 'shadow', statusAtAdvice: 'finished' });
  });
});
