// Issue #2355: a parked job picked up to resume on another machine from its checkpoint found no way to the hopper in its
// pane there (HOPPER_URL not set), and each new pane on that machine had none either: it ended failed after 3 attempts.
// Now it goes back to the queue, its session and checkpoint kept, that machine held for a while, and it resumes on a
// healthy machine. Real daemon over the fake herdr.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = { output: ['● The step needs a credential.', '  HOPPER_WAITING', '  for: a vault grant for the deploy key', '  on: vault grant'] };
const DONE = { output: ['● Deployed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('a checkpoint restore with no way to the hopper (issue #2355)', () => {
  it('puts the job back in the queue, holds that machine, and resumes the job on another machine from its checkpoint', async () => {
    const BASE = 'b'.repeat(40);
    const checkpoint: CheckpointCapture = {
      taken: { branch: 'hopper/deploy', base: BASE, head: 'c'.repeat(40), commits: [], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
    };
    const repositories = [`${homedir()}/deploy`];
    const seat = createFakeHerdrClient({ session: 'seat-s', turns: [WAIT], repositories, checkpoint });
    const host = createFakeHerdrClient({ session: 'host-s', turns: [DONE], repositories, checkpoint, restore: 'no-way' });
    const spare = createFakeHerdrClient({ session: 'spare-s', turns: [DONE], repositories, checkpoint });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const machines = (['seat', 'host', 'spare'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/deploy', session: `${name}-s` } }));
    const a = t = await startTestApp({
      dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines },
      seams: { herdr: seat, herdrSessions: { 'seat-s': seat, 'host-s': host, 'spare-s': spare }, herdrSession: async () => {}, levels: [] },
    });
    const admin = await a.login();
    const drain = async (machineId: string, drained: boolean) => expect((await a.ui('/ui/api/machines/drain', { machineId, drained }, { token: admin })).status).toBe(200);

    // It starts on seat and goes on its own wait: its agent ends, its checkpoint is taken.
    await drain('host', true);
    await drain('spare', true);
    const waiter = await a.pull({}, { executor: 'herdr-claude', prompt: 'Deploy it', env: {} });
    const waiting = await a.waitForStatus(waiter.id, 'waiting_on', 8000);
    const session = waiting.agentSession;
    expect(session).toBeDefined();
    await waitFor(async () => { const j = await a.job(waiter.id); return j.waitReleased?.checkpointAt ? j : undefined; }, { what: 'its checkpoint', timeoutMs: 20000 });

    // Woken, it goes to host, whose pane has no way to the hopper: back in the queue, never failed.
    await drain('host', false);
    await drain('seat', true);
    expect((await a.ui(`/ui/api/jobs/${waiter.id}/end-wait`, {}, { token: admin })).status).toBe(200);
    const requeued = await waitFor(async () => (await a.events('types=job.requeued')).find((e) => e.jobId === waiter.id && /no way to the hopper/.test((e.data as { reason: string }).reason)),
      { what: 'the job back in the queue', timeoutMs: 20000 });
    expect((requeued.data as { reason: string }).reason).toContain('host');
    expect(host.restores).toHaveLength(1);
    const queued = await a.job(waiter.id);
    expect(queued.status).toBe('queued');
    expect(queued.agentSession).toBe(session);
    expect(queued.parked?.elsewhere).toBeDefined();

    // spare takes it; host is held, so it is not placed there again.
    await drain('spare', false);
    const back = await a.waitForStatus(waiter.id, 'finished', 15000);
    expect(back.agentSession).toBe(session);
    expect((await a.events('types=job.started')).filter((e) => e.jobId === waiter.id).at(-1)!.laneId).toContain('spare');
    expect(spare.restores).toHaveLength(1);
    expect(spare.restores[0]).toContain(`'${BASE}' 'hopper/deploy' '${session}'`);
    expect(spare.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session!]));
    expect(host.restores).toHaveLength(1);
    expect((await a.events('types=job.failed')).filter((e) => e.jobId === waiter.id)).toHaveLength(0);
  });
});
