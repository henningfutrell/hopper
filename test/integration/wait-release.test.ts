// Issue #2303: jobs on their own wait kept their agent sessions live, and on a machine short of memory those sessions alone
// held enough memory that the memory floor (issue #2291) admitted no new job, with nothing running. Issue #2326: every job on
// its own wait (a wait the hopper watches) has its agent ended at once, memory short or not; each keeps its wait, work tree
// and agent session, and its checkpoint is taken. When its wait ends, it resumes its session on any machine with room, from
// that checkpoint. Real daemon over the fake herdr.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, FailuresView, Job, ResourceReading } from '../../src/domain/types.ts';
import { WAIT_RELEASED_NOTE } from '../../src/engine/wait.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { RELEASED_NOTE } from '../../src/executors/herdr/restored.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const GIB = 1024 ** 3;
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = { output: ['● The step needs a credential.', '  HOPPER_WAITING', '  for: a vault grant for the deploy key', '  on: vault grant'] };
const done = (what: string) => ({ output: [`● ${what}`, '  HOPPER_DONE'] });
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = (what: string) => ({ executor: 'herdr-claude', prompt: what, cwd: '/tmp', env: {} });

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('a wait release (issues #2303, #2326)', () => {
  it('ends the agent of a job on its own wait at once, with nothing queued; woken, it resumes its session on another machine from its checkpoint', async () => {
    const BASE = 'b'.repeat(40);
    const checkpoint: CheckpointCapture = {
      taken: { branch: 'hopper/deploy', base: BASE, head: 'c'.repeat(40), commits: [], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
    };
    const repositories = [`${homedir()}/deploy`];
    const seat = createFakeHerdrClient({ session: 'seat-s', turns: [WAIT], repositories, checkpoint });
    const host = createFakeHerdrClient({ session: 'host-s', turns: [done('Deployed.')], repositories, checkpoint });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/deploy', session: `${name}-s` } }));
    const a = t = await startTestApp({
      dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines },
      seams: { herdr: seat, herdrSessions: { 'seat-s': seat, 'host-s': host }, herdrSession: async () => {}, levels: [] },
    });
    const admin = await a.login();
    const drain = async (machineId: string, drained: boolean) => expect((await a.ui('/ui/api/machines/drain', { machineId, drained }, { token: admin })).status).toBe(200);

    // It starts on seat (host drained), and goes on its own wait.
    await drain('host', true);
    const waiter = await a.pull({}, { executor: 'herdr-claude', prompt: 'Deploy it', env: {} });
    const waiting = await a.waitForStatus(waiter.id, 'waiting_on', 8000);
    const session = waiting.agentSession;
    expect(session).toBeDefined();

    // Nothing is queued and the memory holds every job: its agent still ends, and its checkpoint is taken.
    await waitFor(async () => (await a.events('types=job.wait_released')).length > 0, { what: 'a wait release', timeoutMs: 20000 });
    const paneId = (waiting.executorState as { paneId: string }).paneId;
    await waitFor(() => seat.closed.includes(paneId), { what: 'the waiting job\'s pane closed' });
    const released = await waitFor(async () => { const j = await a.job(waiter.id); return j.checkpoint?.session ? j : undefined; }, { what: 'its checkpoint' });
    expect(released.status).toBe('waiting_on');
    expect(released.waitReleased?.machineId).toBe('seat');
    // Its pane closed, and its id may name another job's pane by now: its terminal is refused (issue #2335).
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/terminal/screen`, {}, { token: admin })).status).toBe(409);

    // seat takes no new job now, host does. Woken, it resumes its own session on host, from its checkpoint.
    await drain('host', false);
    await drain('seat', true);
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/end-wait`, {}, { token: admin })).status).toBe(200);
    const back = await a.waitForStatus(waiter.id, 'finished', 8000);
    expect(back.agentSession).toBe(session);
    expect(back.waitReleased).toBeUndefined();
    expect(back.parked).toBeUndefined();
    expect((await a.events('types=job.started')).filter((e) => e.jobId === waiter.id).at(-1)!.laneId).toContain('host');
    expect(host.restores).toHaveLength(1);
    expect(host.restores[0]).toContain(`'${BASE}' 'hopper/deploy' '${session}'`);
    expect(host.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session!]));
    const told = host.prompts.at(-1)!.text;
    expect(told).toContain(WAIT_RELEASED_NOTE);
    expect(told).toContain('A person ended your wait');
  });

  it('a gated outside wait with no check is released, and stays parked until a person ends it; then it resumes on another machine (issue #2338)', async () => {
    const GATED = { output: ['● The plan is ready.', '  HOPPER_WAITING', '  for: the production apply', '  on: outside: gated: the production apply'] };
    const checkpoint: CheckpointCapture = {
      taken: { branch: 'hopper/deploy', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: [], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
    };
    const repositories = [`${homedir()}/deploy`];
    const seat = createFakeHerdrClient({ session: 'seat-s', turns: [GATED], repositories, checkpoint });
    const host = createFakeHerdrClient({ session: 'host-s', turns: [done('The apply is done.')], repositories, checkpoint });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/deploy', session: `${name}-s` } }));
    const a = t = await startTestApp({
      dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines },
      seams: { herdr: seat, herdrSessions: { 'seat-s': seat, 'host-s': host }, herdrSession: async () => {}, levels: [] },
    });
    const admin = await a.login();
    const drain = async (machineId: string, drained: boolean) => expect((await a.ui('/ui/api/machines/drain', { machineId, drained }, { token: admin })).status).toBe(200);
    await drain('host', true);
    const waiter = await a.pull({}, { executor: 'herdr-claude', prompt: 'Deploy it', env: {} });
    const waiting = await a.waitForStatus(waiter.id, 'waiting_on', 8000);
    expect(waiting.wait?.on).toEqual({ kind: 'outside', what: 'the production apply', why: 'gated' });

    // Its agent ends: no pane, no lane, its checkpoint marked. The hopper has no check that wakes it.
    const paneId = (waiting.executorState as { paneId: string }).paneId;
    await waitFor(() => seat.closed.includes(paneId), { what: 'the waiting job\'s pane closed', timeoutMs: 20000 });
    const released = await waitFor(async () => { const j = await a.job(waiter.id); return j.waitReleased?.checkpointAt && j.wait?.check ? j : undefined; }, { what: 'its checkpoint marked' });
    expect(released.status).toBe('waiting_on');
    expect(released.laneId).toBeUndefined();
    expect(released.wait!.check!.condition).toEqual({ kind: 'none' });
    expect(seat.agentStarts).toHaveLength(1);

    // A person ends the wait: it resumes its own session on host.
    await drain('host', false);
    await drain('seat', true);
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/end-wait`, {}, { token: admin })).status).toBe(200);
    const back = await a.waitForStatus(waiter.id, 'finished', 15000);
    expect(back.agentSession).toBe(waiting.agentSession);
    expect((await a.events('types=job.started')).filter((e) => e.jobId === waiter.id).at(-1)!.laneId).toContain('host');
    expect(host.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', waiting.agentSession!]));
    expect(host.prompts.at(-1)!.text).toContain('A person ended your wait');
  });

  it('a job that waits for memory, with nothing running, finds the agent of a job on its own wait ended; that job resumes its session when its wait ends', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, done('Built it.'), done('Deployed.')] });
    const memory = { availableGiB: 9 };
    const db = tempDbPath();
    cleanup = db.cleanup;
    const localResources = (): ResourceReading => ({ cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: memory.availableGiB * GIB });
    const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(2) }, seams: { herdr, levels: [], localResources } });

    const waiter = await a.pull({}, item('Deploy it'));
    const waiting = await a.waitForStatus(waiter.id, 'waiting_on', 8000);
    const session = waiting.agentSession;
    expect(session).toBeDefined();

    // The waiting session keeps the memory: 2 GiB available, the floor 1.4 GiB, a new job needs 2 GiB.
    memory.availableGiB = 2;
    const builder = await a.pull({}, item('Build it'));
    await waitFor(async () => (await a.events('types=job.wait_released')).length > 0, { what: 'a wait release', timeoutMs: 20000 });
    const [released] = await a.events('types=job.wait_released');
    expect(released!.jobId).toBe(waiter.id);
    expect(released!.machineId).toBe('local');
    const kept: Job = await a.job(waiter.id);
    expect(kept.status).toBe('waiting_on');
    expect(kept.waitReleased?.machineId).toBe('local');
    // Its agent ended, and it is not taken for a stranded wait.
    const paneId = (waiting.executorState as { paneId: string }).paneId;
    await waitFor(() => herdr.closed.includes(paneId), { what: 'the waiting job\'s pane closed' });
    expect((await a.job(waiter.id)).wait?.strandedAt).toBeUndefined();
    // Nothing runs and a job waits for memory: the Failures view says so.
    const view = (await a.api<FailuresView>('GET', '/api/failures')).body;
    expect(view.stuck.find((c) => c.cause === 'memory_starved')).toMatchObject({ ids: [builder.id] });

    // The release freed the memory: the waiting job starts.
    memory.availableGiB = 9;
    await a.waitForStatus(builder.id, 'finished', 8000);

    // Its wait ends: it resumes its own session in a new pane, told why its agent ended.
    const token = await a.login();
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/end-wait`, {}, { token })).status).toBe(200);
    const back = await a.waitForStatus(waiter.id, 'finished', 8000);
    expect(back.agentSession).toBe(session);
    expect(back.waitReleased).toBeUndefined();
    expect(herdr.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session!]));
    expect(herdr.prompts.at(-1)!.text).toContain(RELEASED_NOTE);
  });
});
