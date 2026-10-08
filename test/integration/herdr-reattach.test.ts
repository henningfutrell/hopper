// A daemon restart while a herdr-claude job runs (design.md "Recovery at startup"): two app
// instances over one database and ONE fake herdr, which stands for the herdr server that
// outlives the daemon. The job's pane and Claude survive, so the job is reattached, not failed.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { openAdminStore } from '../support/files.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
/** A turn long enough (one step per poll) to still be working when the daemon restarts. */
const LONG: FakeTurn = {
  steps: Array.from({ length: 40 }, (_, i) => `● Painting plank ${i + 1}`),
  output: ['● Painted the shed.', '  HOPPER_DONE'],
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

async function boot(herdr: FakeHerdrClient, laneCount = 4, env: Record<string, string> = {}): Promise<TestApp> {
  const a = await startTestApp({ dbPath, source, env, plugins: { executors: EXECUTORS, machines: lanes(laneCount) }, seams: { herdr } });
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

/** The same herdr, unreachable while `down` (a client target not dialled in yet, an ssh probe not answered): every call rejects. */
function reachable(herdr: FakeHerdrClient): { herdr: FakeHerdrClient; link: { down: boolean } } {
  const link = { down: false };
  const proxied = new Proxy(herdr, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => (link.down ? Promise.reject(new Error('client lab is not dialled in')) : (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
  return { herdr: proxied, link };
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

  // Issue #278: the prompt never reached Claude, which sat idle at an empty prompt across restarts.
  it('a prompt that never reached Claude is sent again after the restart: the job never stays running on an idle Claude', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG], dropsPrompts: 1 });
    const { job } = await runThenStop(herdr);

    const second = await boot(herdr);
    const done = await second.waitForStatus(job.id, 'finished', 15000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.') });
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toBe(herdr.prompts[0]!.text);
    expect(herdr.agentStarts).toHaveLength(1);
  });

  it('a prompt left unsent in Claude\'s input box is submitted after the restart, never pasted twice', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG], promptsLeftInInput: 1 });
    const { job, paneId } = await runThenStop(herdr);

    const second = await boot(herdr);
    const done = await second.waitForStatus(job.id, 'finished', 15000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.') });
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.keys).toContainEqual({ paneId, keys: ['enter'] });
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

  // Issue #368: a client target dials in a few seconds after the daemon starts; its running job was failed before it did.
  it('its machine not reachable yet at startup: the job stays running on its lane and is reattached once the machine answers', async () => {
    freshDb();
    const { herdr, link } = reachable(createFakeHerdrClient({ session: 'jh-test', turns: [LONG] }));
    const { job, paneId } = await runThenStop(herdr);
    link.down = true;

    const second = await boot(herdr, 4, { HOPPER_RECONNECT_GRACE_MS: '30000' });
    await new Promise((r) => setTimeout(r, 300));
    const waiting = await second.job(job.id);
    expect(waiting.status).toBe('running');
    expect(waiting.laneId).toBe(job.laneId);
    const held = (await second.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];
    expect(held.find((l) => l.id === job.laneId)).toMatchObject({ state: 'busy', jobId: job.id });

    link.down = false;
    const done = await second.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.'), paneId });
    expect(herdr.agentStarts).toHaveLength(1);
    const events = (await second.events()).filter((e) => e.jobId === job.id);
    expect(events.find((e) => e.type === 'job.reattached')).toMatchObject({ laneId: job.laneId, data: { reason: 'daemon restart' } });
    expect(events.some((e) => e.type === 'job.failed' || e.type === 'job.requeued')).toBe(false);
  });

  it('its machine never reachable within the reconnect grace: failed with a reason naming the machine, lane freed', async () => {
    freshDb();
    const { herdr, link } = reachable(createFakeHerdrClient({ session: 'jh-test', turns: [LONG] }));
    const { job } = await runThenStop(herdr);
    link.down = true;

    const second = await boot(herdr, 4, { HOPPER_RECONNECT_GRACE_MS: '500' });
    const failed = await second.waitForStatus(job.id, 'failed', 8000);
    expect(failed.error).toBe('machine local did not reconnect within 0.5 s after the daemon restart');
    const after = (await second.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; jobId?: string }[];
    expect(after.some((l) => l.jobId === job.id)).toBe(false);
    const events = (await second.events()).filter((e) => e.jobId === job.id);
    expect(events.some((e) => e.type === 'job.reattached')).toBe(false);
  });

  it('cancelled while its machine is not reachable yet: cancelled, never reattached', async () => {
    freshDb();
    const { herdr, link } = reachable(createFakeHerdrClient({ session: 'jh-test', turns: [LONG] }));
    const { job } = await runThenStop(herdr);
    link.down = true;

    const second = await boot(herdr, 4, { HOPPER_RECONNECT_GRACE_MS: '30000' });
    await new Promise((r) => setTimeout(r, 300));
    second.user().engine.cancel(job.id, 'no longer wanted');
    await second.waitForStatus(job.id, 'cancelled', 8000);
    const after = (await second.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; jobId?: string }[];
    expect(after.some((l) => l.jobId === job.id)).toBe(false);
    link.down = false;
    await new Promise((r) => setTimeout(r, 300));
    expect((await second.job(job.id)).status).toBe('cancelled');
  });

  // Issue #371: the job's machine is not reached within the reconnect grace (issue #368), so the job fails,
  // but its pane and Claude live on there.
  it('a pane the restart could not reach stays due for cleanup; a rerun of its item is held until it is closed', async () => {
    freshDb();
    const { herdr, link } = reachable(createFakeHerdrClient({ session: 'jh-test', turns: [LONG, { output: ['● Done.', '  HOPPER_DONE'] }] }));
    const { job, paneId, agentName } = await runThenStop(herdr);
    link.down = true;

    const second = await boot(herdr, 4, { HOPPER_RECONNECT_GRACE_MS: '500' });
    const failed = await second.waitForStatus(job.id, 'failed', 8000);
    expect(failed.error).toBe('machine local did not reconnect within 0.5 s after the daemon restart');
    const deferred = await waitFor(async () => (await second.job(job.id)).cleanupDeferred, { what: 'the cleanup deferred' });
    expect(deferred.error).toContain('not dialled in');
    expect((await second.events('types=job.cleanup_deferred')).filter((e) => e.jobId === job.id)).toHaveLength(1);

    const token = await second.login();
    await waitFor(async () => (await second.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'the failure reported' });
    const rerun = (await second.ui<Job>(`/ui/api/jobs/${job.id}/rerun`, {}, { token })).body;
    const held = await waitFor(async () => { const j = await second.job(rerun.id); return j.status === 'held' ? j : undefined; }, { what: 'the rerun held' });
    expect(held.holdReason).toContain(job.id);
    expect(herdr.agentStarts).toHaveLength(1); // the rerun never ran beside the live pane

    // The machine comes back: the pane is closed at the next try, then the rerun runs.
    link.down = false;
    await waitFor(() => herdr.closed.includes(paneId), { what: 'the old pane closed' });
    expect(await herdr.getAgent(agentName)).toBeNull();
    await second.waitForStatus(rerun.id, 'finished', 8000);
    expect((await second.job(job.id)).cleanupDeferred).toBeUndefined();
    expect((await second.events('types=job.cleaned_up')).filter((e) => e.jobId === job.id)).toHaveLength(1);
    // Never re-deferred once closed.
    expect((await second.events('types=job.cleanup_deferred')).filter((e) => e.jobId === job.id)).toHaveLength(1);
  });

  it('Mark closed ends a deferred cleanup by hand: it is no longer tried, and the held rerun is admitted', async () => {
    freshDb();
    const { herdr, link } = reachable(createFakeHerdrClient({ session: 'jh-test', turns: [LONG] }));
    const { job, paneId } = await runThenStop(herdr);
    link.down = true;
    const second = await boot(herdr, 4, { HOPPER_RECONNECT_GRACE_MS: '500' });
    await waitFor(async () => (await second.job(job.id)).cleanupDeferred, { what: 'the cleanup deferred' });
    const token = await second.login();
    await waitFor(async () => (await second.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'the failure reported' });
    const rerun = (await second.ui<Job>(`/ui/api/jobs/${job.id}/rerun`, {}, { token })).body;
    await waitFor(async () => (await second.job(rerun.id)).status === 'held', { what: 'the rerun held' });

    const marked = await waitFor(async () => { const r = await second.ui<Job>(`/ui/api/jobs/${job.id}/cleaned-up`, {}, { token }); return r.status === 200 ? r : undefined; }, { what: 'Mark closed accepted' });
    expect(marked.body.cleanupDeferred).toBeUndefined();
    expect((await second.events('types=job.cleaned_up')).find((e) => e.jobId === job.id)?.data).toMatchObject({ by: 'user' });
    expect((await second.ui(`/ui/api/jobs/${job.id}/cleaned-up`, {}, { token })).status).toBe(409);
    expect((await second.ui(`/ui/api/jobs/${rerun.id}/cleaned-up`, {}, { token })).status).toBe(409);

    // No longer held: it is admitted at once (and here fails, its machine still unreached).
    await waitFor(async () => !['queued', 'held'].includes((await second.job(rerun.id)).status), { what: 'the rerun admitted' });
    link.down = false;
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.closed).not.toContain(paneId); // never tried again once marked
  });

  it('a claimed herdr-claude job (nothing ran yet) is requeued and runs', async () => {
    freshDb();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    const first = await boot(herdr, 0);
    const pulled = await first.pull({}, item);
    await waitFor(async () => (await first.job(pulled.id)).waitReason !== undefined, { what: 'the job waiting for a lane' });
    await first.stop();
    // The crash window between claim and start, which no API can produce.
    const store = openAdminStore(databaseUrlFor(dbPath));
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
