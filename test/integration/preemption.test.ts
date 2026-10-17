// Preemption (issue #1525): with every lane busy on a lower-priority job, a job of higher priority that is queued takes
// a lane. The running job is parked on the Park button's path — its work tree and agent session kept —, queued again at
// once, and resumes its own agent session once a lane is free. Equal priority never preempts; nor does a job that has run
// less than the minimum run time; nor anything while preemption is off. The settings: GET /api/preemption,
// POST /ui/api/preemption. Real daemon over the fake herdr, as park.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, PreemptionSettings } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

const done = (what: string) => ({ output: [`● ${what}`, '  HOPPER_DONE'] });
/** A turn that never ends by itself: the job is mid-turn when it is preempted. */
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const low = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const high = { executor: 'herdr-claude', prompt: 'Fix the roof', cwd: '/tmp', env: {}, priority: 80, priorityReason: 'label:hopper:high' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const setPreemption = (a: TestApp, token: string, body: Partial<PreemptionSettings>) => a.ui<PreemptionSettings>('/ui/api/preemption', body, { token });
const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);

/** A low-priority job running mid-turn on the one lane, its agent session recorded. */
async function lowRunning(a: TestApp, herdr: FakeHerdrClient): Promise<Job> {
  const job = await a.pull({}, low);
  await a.waitForStatus(job.id, 'running');
  await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
  await waitFor(async () => (await a.job(job.id)).agentSession !== undefined, { what: 'the agent session recorded' });
  return a.job(job.id);
}

describe('preemption', () => {
  it('the settings default to on with a 10 minute minimum run time; an admin changes them, and the change is an event', async () => {
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }));
    const token = await a.login();
    expect((await a.api('GET', '/api/preemption')).body).toEqual({ enabled: true, minRunMinutes: 10 });
    const r = await setPreemption(a, token, { minRunMinutes: 20 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true, minRunMinutes: 20 });
    expect((await a.events('types=preemption.settings_changed'))[0]!.data).toMatchObject({ from: { enabled: true, minRunMinutes: 10 }, to: { enabled: true, minRunMinutes: 20 } });
    expect((await setPreemption(a, token, { minRunMinutes: -1 })).status).toBe(400);
    expect((await setPreemption(a, token, {})).status).toBe(400);
  });

  it('a high-priority job parks the low one and starts; the low one resumes its own session from where it stopped', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, done('Fixed the roof.'), done('Painted the shed.')] });
    const a = await boot(herdr);
    const token = await a.login();
    await setPreemption(a, token, { minRunMinutes: 0 });
    const lowJob = await lowRunning(a, herdr);
    const session = lowJob.agentSession!;

    const highJob = await a.pull({}, high);
    await waitFor(async () => (await a.events('types=job.preempted')).length > 0, { what: 'the low job preempted', timeoutMs: 5000 });
    const [event] = await a.events('types=job.preempted');
    expect(event!.jobId).toBe(lowJob.id);
    const preempted = event!.data;
    expect(preempted).toMatchObject({ by: highJob.id, byPriority: 80, priority: 50 });
    await a.waitForStatus(highJob.id, 'finished', 8000);
    const back = await a.waitForStatus(lowJob.id, 'finished', 8000);

    const types = (await ofJob(a, lowJob.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['job.preempted', 'job.parked', 'job.unparked']));
    expect(types).not.toContain('job.failed');
    expect(types).not.toContain('job.cancelled');
    // Resumed, not started again: its own session, with no second task prompt.
    expect(herdr.agentStarts).toHaveLength(3);
    expect(herdr.agentStarts[2]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.prompts[2]!.text).not.toContain('Paint the shed');
    expect(back.preempted).toBeUndefined();
    expect(back.priority).toBe(50);
  });

  it('a job of equal priority never preempts', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING] });
    const a = await boot(herdr);
    const token = await a.login();
    await setPreemption(a, token, { minRunMinutes: 0 });
    const lowJob = await lowRunning(a, herdr);
    const same = await a.pull({}, { ...low, prompt: 'Paint the fence' });
    await sleep(1500);
    expect((await a.job(lowJob.id)).status).toBe('running');
    expect((await a.job(same.id)).status).toBe('queued');
    expect(await a.events('types=job.preempted')).toEqual([]);
  });

  it('honours the minimum run time, and preempts nothing while it is off', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING] });
    const a = await boot(herdr);
    const token = await a.login();
    const lowJob = await lowRunning(a, herdr);
    const highJob = await a.pull({}, high);
    await sleep(1500);
    // The default 10 minutes have not passed.
    expect((await a.job(lowJob.id)).status).toBe('running');
    expect((await a.job(highJob.id)).status).toBe('queued');
    await setPreemption(a, token, { enabled: false, minRunMinutes: 0 });
    await sleep(1500);
    expect((await a.job(lowJob.id)).status).toBe('running');
    expect(await a.events('types=job.preempted')).toEqual([]);
  });
});
