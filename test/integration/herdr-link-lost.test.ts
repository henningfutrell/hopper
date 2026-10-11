// A machine's link drops while its herdr-claude job runs (issue #752): the job is held on its lane, not failed, and is
// watched again once the link is back and its pane is alive; it fails only when the reconnect grace runs out. The fake
// herdr's setUnreachable stands for a client target whose link is down: every call rejects, the pane lives on.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
/** A turn long enough (one step per poll) to still be working when the link drops. */
const LONG: FakeTurn = {
  steps: Array.from({ length: 60 }, (_, i) => `● Painting plank ${i + 1}`),
  output: ['● Painted the shed.', '  HOPPER_DONE'],
};
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp' };

let app: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  cleanup?.();
});

async function running(herdr: FakeHerdrClient, graceMs: number): Promise<{ app: TestApp; jobId: string; paneId: string; agentName: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  app = await startTestApp({
    dbPath: db.dbPath, source: createManualSource(), env: { HOPPER_RECONNECT_GRACE_MS: String(graceMs) },
    plugins: { executors: EXECUTORS, machines: lanes(4) }, seams: { herdr },
  });
  const pulled = await app.pull({}, item);
  await waitFor(() => herdr.prompts.length === 1);
  const job = await app.waitForStatus(pulled.id, 'running');
  const { paneId, agentName } = (await waitFor(async () => (await app!.job(job.id)).executorState?.turn ? app!.job(job.id) : undefined)).executorState as { paneId: string; agentName: string };
  return { app, jobId: job.id, paneId, agentName };
}

const eventsOf = async (a: TestApp, jobId: string) => (await a.events()).filter((e) => e.jobId === jobId);

describe('herdr-claude job when its machine\'s link drops', () => {
  it('held on its lane while the link is down, then watched again from its turn once the link is back: it finishes', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { app: a, jobId, paneId } = await running(herdr, 30000);
    herdr.setUnreachable(true);

    const lost = await waitFor(async () => (await eventsOf(a, jobId)).find((e) => e.type === 'job.link_lost'), { what: 'job.link_lost' });
    expect(lost.data).toMatchObject({ machine: 'local', since: expect.any(String), failsAt: expect.any(String) });
    await new Promise((r) => setTimeout(r, 300));
    const held = await a.job(jobId);
    expect(held.status).toBe('running');
    expect(held.linkLost).toMatchObject({ machine: 'local', since: lost.data.since, failsAt: lost.data.failsAt });
    expect(Date.parse(held.linkLost!.failsAt) - Date.parse(held.linkLost!.since)).toBe(30000);
    const lanesNow = (await a.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];
    expect(lanesNow.find((l) => l.id === held.laneId)).toMatchObject({ state: 'busy', jobId });

    herdr.setUnreachable(false);
    const done = await a.waitForStatus(jobId, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.'), paneId });
    expect(done.linkLost).toBeUndefined();
    expect(herdr.prompts).toHaveLength(1); // never re-prompted
    expect(herdr.agentStarts).toHaveLength(1); // never re-run
    const events = await eventsOf(a, jobId);
    expect(events.find((e) => e.type === 'job.reattached')).toMatchObject({ data: { reason: 'link restored' } });
    expect(events.some((e) => e.type === 'job.failed' || e.type === 'job.requeued')).toBe(false);
  });

  it('the link not back within the reconnect grace: failed with a reason naming the machine, its cleanup deferred', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { app: a, jobId, paneId } = await running(herdr, 500);
    herdr.setUnreachable(true);

    const failed = await a.waitForStatus(jobId, 'failed', 8000);
    expect(failed.error).toBe('machine local did not reconnect within 0.5 s');
    expect(failed.linkLost).toBeUndefined();
    const deferred = await waitFor(async () => (await a.job(jobId)).cleanupDeferred, { what: 'the cleanup deferred' });
    expect(deferred.error).toContain('not dialled in');
    const events = await eventsOf(a, jobId);
    expect(events.some((e) => e.type === 'job.link_lost')).toBe(true);
    expect(events.some((e) => e.type === 'job.reattached')).toBe(false);

    // The link comes back: the pane that may have run on is closed by the deferred cleanup.
    herdr.setUnreachable(false);
    await waitFor(() => herdr.closed.includes(paneId), { what: 'the pane closed' });
  });

  it('Claude gone from its pane when the link is back: failed, never watched again', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { app: a, jobId, agentName } = await running(herdr, 30000);
    herdr.setUnreachable(true);
    await waitFor(async () => (await eventsOf(a, jobId)).find((e) => e.type === 'job.link_lost'), { what: 'job.link_lost' });
    herdr.killAgent(agentName);

    herdr.setUnreachable(false);
    const failed = await a.waitForStatus(jobId, 'failed', 8000);
    expect(failed.error).toBe('interrupted while the link to machine local was down');
    expect((await eventsOf(a, jobId)).some((e) => e.type === 'job.reattached')).toBe(false);
  });

  it('cancelled while held: cancelled, never watched again', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { app: a, jobId } = await running(herdr, 30000);
    herdr.setUnreachable(true);
    await waitFor(async () => (await eventsOf(a, jobId)).find((e) => e.type === 'job.link_lost'), { what: 'job.link_lost' });

    a.user().engine.cancel(jobId, 'no longer wanted');
    await a.waitForStatus(jobId, 'cancelled', 8000);
    herdr.setUnreachable(false);
    await new Promise((r) => setTimeout(r, 300));
    expect((await a.job(jobId)).status).toBe('cancelled');
    expect((await eventsOf(a, jobId)).some((e) => e.type === 'job.reattached')).toBe(false);
  });
});
