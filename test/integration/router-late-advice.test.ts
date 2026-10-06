// The router's advice is always applied (issue #211): a job waits for it, so no job starts before the
// router answers, however slow the router is next to the job.
// These run the real gate-router (spawning the shim), so they need a grok-bot-jev checkout; without one
// they skip cleanly.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const HAVE_GROK_BOT_JEV = existsSync(join(homedir(), 'workbench/jev-src/grok-bot-jev', 'src', 'router.py'));

describe.skipIf(!HAVE_GROK_BOT_JEV)('a slow router (real gate-router)', () => {
  let t: TestApp | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    await t?.stop();
    cleanup?.();
  });

  it('a fast job waits for the advice, then runs: job.prioritized names it still waiting', async () => {
    const tmp = tempDbPath();
    cleanup = tmp.cleanup;
    t = await startTestApp({ dbPath: tmp.dbPath, realRouter: true });

    const job = await t.pull({ op: 'echo', message: 'fast' }, { title: 'say hi' });
    const done = await t.waitForStatus(job.id, 'finished', 15000);
    expect(done.advice).toMatchObject({ action: 'proceed_full', source: 'gate-router', details: { gatesAsked: false } });
    const prioritized = (await t.events('types=job.prioritized')).filter((e) => e.jobId === job.id);
    expect(prioritized).toHaveLength(1);
    expect(prioritized[0]!.data).toEqual({ advice: expect.any(Object), statusAtAdvice: expect.stringMatching(/^(queued|held)$/) });
  });

  it('reaches every job pulled in a burst before any of them starts', async () => {
    const tmp = tempDbPath();
    cleanup = tmp.cleanup;
    t = await startTestApp({ dbPath: tmp.dbPath, realRouter: true });

    for (let i = 0; i < 8; i++) t.source.add(manualItem({ prompt: JSON.stringify({ op: 'echo', message: `burst ${i}` }), priority: 10 * i }));
    await t.sync();
    const jobs = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs).toHaveLength(8);
    for (const job of jobs) await t.waitForStatus(job.id, 'finished', 20000);

    await waitFor(async () => {
      const all = await Promise.all(jobs.map((j) => t!.job(j.id)));
      return all.every((j) => j.advice?.source === 'gate-router');
    }, { timeoutMs: 12000, what: 'advice on every burst job' });
  });
});
