// A daemon restart while a herdr-claude job runs (design.md "Recovery at startup"): two app
// instances over one SQLite file and ONE fake herdr, which stands for the herdr server that
// outlives the daemon. The job's pane and Claude survive, so the job is reattached, not failed.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { openStore } from '../../src/store/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleQuestionMs: 5000 } }];
/** A turn long enough (one step per poll) to still be working when the daemon restarts. */
const LONG: FakeTurn = {
  steps: Array.from({ length: 40 }, (_, i) => `● Painting plank ${i + 1}`),
  output: ['● Painted the shed.', '  JOB_HOPPER_DONE'],
};
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp' };

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;
let dbPath = '';
let source = createManualSource();

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

function freshDb(): void {
  source = createManualSource();
  const db = tempDbPath();
  cleanup = db.cleanup;
  dbPath = db.dbPath;
}

async function boot(herdr: FakeHerdrClient, laneCount = 4): Promise<TestApp> {
  const a = await startTestApp({ dbPath, source, plugins: { executors: EXECUTORS, machines: lanes(laneCount) }, seams: { herdr } });
  apps.push(a);
  return a;
}

/** Pull a herdr-claude job, wait until its prompt is in the pane, stop the daemon. */
async function runThenStop(herdr: FakeHerdrClient): Promise<{ job: Job; paneId: string; agentName: string }> {
  const first = await boot(herdr);
  const pulled = await first.pull({}, item);
  await waitFor(() => herdr.prompts.length === 1);
  const job = await first.waitForStatus(pulled.id, 'running');
  await first.stop();
  const { paneId, agentName } = job.executorState as { paneId: string; agentName: string };
  return { job, paneId, agentName };
}

describe('herdr-claude job across a daemon restart', () => {
  it('stop leaves the running job\'s pane open; the restarted daemon reattaches it and it finishes when the turn ends', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { job, paneId } = await runThenStop(herdr);
    expect(herdr.closed).toEqual([]);

    const second = await boot(herdr);
    const after = await second.job(job.id);
    expect(after.status).toBe('running');
    expect(after.laneId).toBe(job.laneId);
    const lanes = (await second.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];
    expect(lanes.find((l) => l.id === job.laneId)).toMatchObject({ state: 'busy', jobId: job.id });

    const done = await second.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.'), paneId });
    expect(herdr.prompts).toHaveLength(1); // never re-prompted
    expect(herdr.agentStarts).toHaveLength(1); // never re-run
    const events = (await second.events()).filter((e) => e.jobId === job.id);
    const reattached = events.find((e) => e.type === 'job.reattached');
    expect(reattached).toMatchObject({ laneId: job.laneId, data: { reason: 'daemon restart' } });
    expect(events.some((e) => e.type === 'job.requeued' || e.type === 'job.failed')).toBe(false);
    expect(events.filter((e) => e.type === 'job.started')).toHaveLength(1);
    await waitFor(() => herdr.closed.includes(paneId));
  });

  it('a turn that ended while the daemon was down is detected at once', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { job, agentName } = await runThenStop(herdr);
    // Time passes with no daemon: Claude finishes the turn in its pane.
    await waitFor(async () => (await herdr.getAgent(agentName))?.status === 'idle', { intervalMs: 1 });

    const second = await boot(herdr);
    const done = await second.waitForStatus(job.id, 'finished', 3000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.') });
    expect(herdr.prompts).toHaveLength(1);
  });

  it('Claude gone from the pane → failed "interrupted by daemon restart" and the pane closed', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { job, paneId, agentName } = await runThenStop(herdr);
    herdr.killAgent(agentName);

    const second = await boot(herdr);
    const failed = await second.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe('interrupted by daemon restart');
    await waitFor(() => herdr.closed.includes(paneId));
    const events = (await second.events()).filter((e) => e.jobId === job.id);
    expect(events.some((e) => e.type === 'job.reattached')).toBe(false);
    expect(herdr.prompts).toHaveLength(1);
  });

  it('a claimed herdr-claude job (nothing ran yet) is requeued and runs', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [{ output: ['● Done.', '  JOB_HOPPER_DONE'] }] });
    const first = await boot(herdr, 0);
    const pulled = await first.pull({}, item);
    await first.waitForStatus(pulled.id, 'held');
    await first.stop();
    // The crash window between claim and start, which no API can produce.
    const store = openStore({ url: databaseUrlFor(dbPath), clock: { now: () => new Date() } });
    const lane = store.lanes.open('local');
    store.lanes.update(lane.id, { state: 'busy', jobId: pulled.id });
    store.jobs.update(pulled.id, { status: 'claimed', laneId: lane.id, holdReason: undefined });
    store.close();

    const second = await boot(herdr);
    await second.waitForStatus(pulled.id, 'finished', 8000);
    const requeued = (await second.events()).find((e) => e.type === 'job.requeued' && e.jobId === pulled.id);
    expect(requeued!.data).toEqual({ from: 'claimed', reason: 'daemon restart' });
  });
});
