// The memory floor (issue #2291) through the real daemon over the fake herdr, its machine's memory read through the
// `localResources` seam. A burst of 7 queued jobs on a machine of 8 lanes starts only as many as its memory holds; the
// rest wait for memory, and the API answers throughout. Below the floor the job that started last is paused on the
// preemption's park path, queued again, and resumes its own agent session once the memory holds it.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, ResourceReading } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const GIB = 1024 ** 3;
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

/** A turn that never ends by itself: the job runs until it is paused or the app stops. */
const WORKING = { steps: ['● Building'], output: [], end: 'working' as const };
const done = (what: string) => ({ output: [`● ${what}`, '  HOPPER_DONE'] });
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = (n: number) => ({ executor: 'herdr-claude', prompt: `Build module ${n}`, cwd: '/tmp', env: {} });

/** This machine as a 14 GiB WSL VM: `memory.availableGiB` is what it reads now. */
async function boot(herdr: FakeHerdrClient, memory: { availableGiB: number }): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const localResources = (): ResourceReading => ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: memory.availableGiB * GIB });
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(8) }, seams: { herdr, levels: [], localResources } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const statuses = async (a: TestApp, jobs: readonly Job[]): Promise<string[]> => Promise.all(jobs.map(async (j) => (await a.job(j.id)).status));

describe('the memory floor (issue #2291)', () => {
  it('a burst of 7 queued jobs starts only what the memory holds; the rest wait for memory and the API answers throughout', async () => {
    // 7 GiB available, the floor 1.4 GiB, 2 GiB a job: 2 jobs fit.
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: Array.from({ length: 7 }, () => WORKING) });
    const a = await boot(herdr, { availableGiB: 7 });
    const jobs: Job[] = [];
    for (let n = 1; n <= 7; n++) jobs.push(await a.pull({}, item(n)));
    await waitFor(async () => (await Promise.all(jobs.map((j) => a.job(j.id)))).filter((j) => j.waitReason?.startsWith('waiting for memory:')).length === 5,
      { what: 'five jobs waiting for memory', timeoutMs: 8000 });
    const now = await statuses(a, jobs);
    expect(now.filter((s) => s === 'claimed' || s === 'running')).toHaveLength(2);
    expect(now.filter((s) => s === 'queued')).toHaveLength(5);
    const waiting = await a.job(jobs[6]!.id);
    expect(waiting.waitReason).toMatch(/^waiting for memory: local has 7 GiB available, 4 GiB of it kept for 2 jobs started lately, and a new job needs 2 GiB over its floor of 1\.4 GiB$/);
    const health = await a.api<{ ok: boolean }>('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    // A tick later the memory has not changed: still two.
    await waitFor(async () => (await a.events('types=decision.made')).length >= 2, { what: 'another Decision' });
    expect((await statuses(a, jobs)).filter((s) => s === 'claimed' || s === 'running')).toHaveLength(2);
  });

  it('below the floor the job that started last is paused, queued again, and resumes its own session once the memory holds it', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, WORKING, done('Built module 2.')] });
    const memory = { availableGiB: 9 };
    const a = await boot(herdr, memory);
    const first = await a.pull({}, item(1));
    await waitFor(async () => (await a.job(first.id)).agentSession !== undefined, { what: 'the first job running with its session' });
    const second = await a.pull({}, item(2));
    await waitFor(async () => (await a.job(second.id)).agentSession !== undefined, { what: 'the second job running with its session' });
    const session = (await a.job(second.id)).agentSession;

    memory.availableGiB = 1;
    await waitFor(async () => (await a.events('types=job.memory_paused')).length > 0, { what: 'a memory pause', timeoutMs: 8000 });
    const [paused] = await a.events('types=job.memory_paused');
    expect(paused!.jobId).toBe(second.id);
    expect(paused!.data).toMatchObject({ availableBytes: GIB, floorBytes: 1.4 * GIB });
    // Issue #2737: the job says why it was paused, for the Queue.
    expect((await a.job(second.id)).memoryPaused).toMatchObject({ machineId: 'local', why: 'local has 1 GiB available, below its floor of 1.4 GiB' });
    await waitFor(async () => (await a.job(second.id)).waitReason?.startsWith('waiting for memory:') === true, { what: 'the paused job waiting for memory', timeoutMs: 8000 });
    expect((await a.job(first.id)).status).toBe('running');
    expect((await a.api('GET', '/api/health')).status).toBe(200);
    // One at a time: the first job is not paused while the second's pause is under 2 minutes old.
    expect(await a.events('types=job.memory_paused')).toHaveLength(1);

    memory.availableGiB = 12;
    const back = await a.waitForStatus(second.id, 'finished', 8000);
    expect(back.agentSession).toBe(session);
    const types = (await a.events()).filter((e) => e.jobId === second.id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['job.memory_paused', 'job.parked', 'job.unparked', 'job.finished']));
    expect(types).not.toContain('job.failed');
    expect(back.memoryPaused).toBeUndefined();
  });

  it('below the floor the job of the lowest priority is paused, though another started later (issue #2737)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, WORKING] });
    const memory = { availableGiB: 9 };
    const a = await boot(herdr, memory);
    const low = await a.pull({}, { ...item(1), priority: 10 });
    await waitFor(async () => (await a.job(low.id)).agentSession !== undefined, { what: 'the low job running with its session' });
    const high = await a.pull({}, { ...item(2), priority: 75 });
    await waitFor(async () => (await a.job(high.id)).agentSession !== undefined, { what: 'the high job running with its session' });

    memory.availableGiB = 1;
    await waitFor(async () => (await a.events('types=job.memory_paused')).length > 0, { what: 'a memory pause', timeoutMs: 8000 });
    const [paused] = await a.events('types=job.memory_paused');
    expect(paused!.jobId).toBe(low.id);
    expect(paused!.data).toMatchObject({ reason: expect.stringMatching(/; .+ has the lowest priority there \(10\)$/) });
    expect((await a.job(low.id)).memoryPaused).toMatchObject({ priority: 10 });
    expect((await a.job(high.id)).status).toBe('running');
  });
});
