// A timed-out job, decided from its liveness (issue #630), end to end: real daemon, real database, the manual source.
// The executor records what the job showed at its timeout — when its pane output last changed, whether it pushed
// commits —; the job's source says whether a pull request of its own is open. Active: Continue — its own agent session
// resumes, or, as here where it cannot, its item runs again at once, told to go on. Silent: retried once; silent again,
// a person. Three active timeouts in a row: a person. A pull request lookup that fails never holds the assessment.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, FailureSettings, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(source = createManualSource()): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, source });
  apps.push(a);
  const token = await a.login();
  const r = await a.ui<FailureSettings>('/ui/api/failures/settings', { backoffSec: 1, backoffFactor: 1 }, { token });
  expect(r.status).toBe(200);
  return a;
}

const timedOut = (liveness: Record<string, unknown> = {}) => ({ op: 'fail', message: 'timed out', ms: 0, liveness });
const assessedOf = async (a: TestApp, jobId: string): Promise<DomainEvent> =>
  waitFor(async () => (await a.events('types=job.assessed&limit=1000')).find((e) => e.jobId === jobId), { what: `job ${jobId} assessed` });
/** Every job of the item `key`, oldest first. */
const chain = async (a: TestApp, key: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key).reverse();
const reasonsOf = (e: DomainEvent): string => (e.data.reasons as string[]).join(' ');

describe('a timed-out job, decided from its liveness', () => {
  it('active: Continue — its item runs again at once, told it timed out while at work; the liveness is kept on the job and the record', async () => {
    const a = await boot();
    const job = await a.pull(timedOut({ pushed: true }));
    const e = await assessedOf(a, job.id);
    expect(e.data).toMatchObject({ class: 'transient', decision: 'continue', causeId: 'timed-out', auto: true });
    expect(reasonsOf(e)).toMatch(/commits pushed/);
    expect((await a.job(job.id)).liveness).toMatchObject({ pushed: true });
    const next = await waitFor(async () => (await chain(a, job.source!.key)).find((j) => j.rerunOf === job.id), { what: 'the item run again' });
    const prompt = String(next.spec.payload.prompt);
    expect(prompt).toContain('timed out while it was at work');
    expect(prompt).toContain('pushed branch or its open pull request');
    const rerun = (await a.events('types=job.rerun&limit=1000')).find((x) => x.jobId === job.id);
    expect(rerun?.data).toMatchObject({ by: 'assessor' });
  });

  it('silent: retried once; silent again after that retry: a person', async () => {
    const a = await boot();
    const first = await a.pull(timedOut({ outputAgoSec: 3600 }));
    const key = first.source!.key;
    const jobs = await waitFor(async () => { const c = await chain(a, key); return c.length === 2 && c[1]!.status === 'failed' ? c : undefined; }, { timeoutMs: 10_000, what: 'one retry' });
    expect((await assessedOf(a, jobs[0]!.id)).data).toMatchObject({ decision: 'retry', causeId: 'timed-out' });
    const second = await assessedOf(a, jobs[1]!.id);
    expect(second.data).toMatchObject({ decision: 'person', causeId: 'timed-out' });
    expect(reasonsOf(second)).toMatch(/silent again after its retry/);
    await waitFor(async () => (await a.api<{ handoffs: { jobId: string; status: string }[] }>('GET', '/api/failures')).body.handoffs.find((h) => h.jobId === jobs[1]!.id && h.status === 'open'), { what: 'handed to a person' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await chain(a, key)).toHaveLength(2);
  });

  it('the cap: the third active timeout in a row goes to a person', async () => {
    const a = await boot();
    const first = await a.pull(timedOut({ outputAgoSec: 30 }));
    const key = first.source!.key;
    const jobs = await waitFor(async () => { const c = await chain(a, key); return c.length === 3 && c[2]!.status === 'failed' ? c : undefined; }, { timeoutMs: 10_000, what: 'two continues' });
    expect((await assessedOf(a, jobs[1]!.id)).data).toMatchObject({ decision: 'continue' });
    const third = await assessedOf(a, jobs[2]!.id);
    expect(third.data).toMatchObject({ decision: 'person' });
    expect(reasonsOf(third)).toMatch(/3 timeouts in a row while at work/);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await chain(a, key)).toHaveLength(3);
  });

  it('an open pull request of its own, from its source, makes it active', async () => {
    const source = createManualSource();
    const a = await boot(source);
    const key = `manual:630-pr:${Date.now()}`;
    source.openPullRequest(key);
    const job = await a.pull(timedOut({ outputAgoSec: 3600, pushed: false }), { key });
    const e = await assessedOf(a, job.id);
    expect(e.data).toMatchObject({ decision: 'continue' });
    expect(reasonsOf(e)).toMatch(/a pull request of its own is open/);
    expect((await a.job(job.id)).liveness).toMatchObject({ pullRequest: true });
  });

  it('a pull request lookup that fails does not hold the assessment: the other facts decide', async () => {
    const source = createManualSource();
    source.failPullRequestLookups();
    const a = await boot(source);
    const job = await a.pull(timedOut({ outputAgoSec: 3600, pushed: false }));
    const e = await assessedOf(a, job.id);
    expect(e.data).toMatchObject({ decision: 'retry' });
    expect(reasonsOf(e)).toMatch(/pull request not known/);
  });
});
