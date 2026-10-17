// The lost-machine move (issue #1569): a running herdr-claude job whose machine stays away past the grace resumes on another
// machine from its last checkpoint, and does not fail. A `job-move` saga ends the agent it left on the lost machine once
// that machine answers again, on whichever hopper holds the saga — also one started after the first stopped. Real daemon,
// two machines, each its own fake herdr session, so one can be cut off while the other runs.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
/** Long enough (one step per poll) to still be working when its machine is lost. */
const LONG: FakeTurn = { steps: Array.from({ length: 400 }, (_, i) => `● Painting plank ${i + 1}`), output: ['● Painted the shed.', '  HOPPER_DONE'] };
const DONE: FakeTurn = { output: ['● Painted the last planks.', '  HOPPER_DONE'] };
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} };
const BASE = 'b'.repeat(40);
/** A checkpoint with work and the agent session. */
const CHECKPOINT: CheckpointCapture = {
  taken: { branch: 'hopper/shed', base: BASE, head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
};

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

type Herdrs = Record<'seat' | 'host', FakeHerdrClient>;

const herdrs = (o: { seatTurns?: FakeTurn[]; hostTurns?: FakeTurn[] } = {}): Herdrs => ({
  seat: createFakeHerdrClient({ session: 'seat-s', turns: o.seatTurns ?? [LONG], repositories: [`${homedir()}/shed`], checkpoint: CHECKPOINT }),
  host: createFakeHerdrClient({ session: 'host-s', turns: o.hostTurns ?? [DONE], repositories: [`${homedir()}/shed`], checkpoint: CHECKPOINT }),
});

async function boot(h: Herdrs, dbPath: string, env: Record<string, string> = {}): Promise<TestApp> {
  const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/shed', session: `${name}-s` } }));
  const a = await startTestApp({
    dbPath, env: { HOPPER_LINK_GRACE_MS: '400', HOPPER_RECONNECT_GRACE_MS: '400', ...env },
    plugins: { executors: EXECUTORS, machines },
    seams: { herdr: h.seat, herdrSessions: { 'seat-s': h.seat, 'host-s': h.host }, herdrSession: async () => {}, levels: [] },
  });
  apps.push(a);
  return a;
}

const ofJob = async (a: TestApp, id: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === id);

/** A job at work on one of the two machines, its checkpoint taken: the machine it runs on, and the other. */
async function atWork(a: TestApp, h: Herdrs): Promise<{ job: Job; on: 'seat' | 'host'; other: 'seat' | 'host'; paneId: string }> {
  const pulled = await a.pull({}, item);
  const job = await waitFor(async () => {
    const j = await a.job(pulled.id);
    return j.status === 'running' && (j.executorState as { turn?: unknown } | undefined)?.turn && j.agentSession ? j : undefined;
  }, { what: 'the job at work' });
  const on = (await ofJob(a, job.id)).find((e) => e.type === 'job.started')!.laneId!.includes('seat') ? 'seat' : 'host';
  const k = await a.user().engine.checkpoints.take(job.id);
  expect(typeof k).not.toBe('string');
  expect(h[on].prompts).toHaveLength(1);
  return { job, on, other: on === 'seat' ? 'host' : 'seat', paneId: (job.executorState as { paneId: string }).paneId };
}

describe('the lost-machine move', () => {
  it('a job whose machine stays away past the link grace resumes on the other machine from its checkpoint, and its agent there is ended once that machine answers', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    // Either machine may take the job first: each can play the long turn, then the resumed one.
    const h = herdrs({ seatTurns: [LONG, DONE], hostTurns: [LONG, DONE] });
    const a = await boot(h, db.dbPath);
    const { job, on, other, paneId } = await atWork(a, h);

    h[on].setUnreachable(true);
    const done = await a.waitForStatus(job.id, 'finished', 15000);
    expect(done.parked).toBeUndefined();
    const events = await ofJob(a, job.id);
    expect(events.some((e) => e.type === 'job.failed')).toBe(false);
    expect(events.find((e) => e.type === 'job.parked')!.data).toMatchObject({ from: 'running', machineId: on, auto: true, why: `machine ${on} did not reconnect within 0.4 s` });
    expect(events.find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued', elsewhere: true });
    expect(events.filter((e) => e.type === 'job.started').map((e) => e.laneId)).toEqual([expect.stringContaining(on), expect.stringContaining(other)]);
    // Resumed from the checkpoint on the other machine, in the same session: the task never sent twice.
    expect(h[other].restores).toHaveLength(1);
    expect(h[other].agentStarts.at(-1)!.args.join(' ')).toContain(job.agentSession);
    expect(h[other].prompts).toHaveLength(1);
    expect(h[other].prompts[0]!.text).toContain(`This job was parked on machine ${on} and resumes now on another machine`);
    expect(h[other].prompts[0]!.text).toContain(`This job's run was cut off: machine ${on} did not reconnect within 0.4 s.`);
    expect(h[other].prompts[0]!.text).not.toContain('Paint the shed');

    // The lost machine answers again: the agent left there is ended, its pane closed.
    expect(h[on].closed).not.toContain(paneId);
    h[on].setUnreachable(false);
    await waitFor(() => (h[on].closed.includes(paneId) ? true : undefined), { what: 'the pane left on the lost machine closed', timeoutMs: 15000 });
    expect(h[on].reaps.some((r) => r.jobId === job.id)).toBe(true);
    expect(h[on].prompts).toHaveLength(1);
  });

  it('the agent left on a lost machine is ended by a hopper started after the one that moved the job stopped', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const h = herdrs({ seatTurns: [LONG, LONG], hostTurns: [LONG, LONG] });
    const first = await boot(h, db.dbPath);
    const { job, on, other, paneId } = await atWork(first, h);
    h[on].setUnreachable(true);
    // Moved, and at work on the other machine.
    await waitFor(async () => ((await ofJob(first, job.id)).filter((e) => e.type === 'job.started').length === 2 ? true : undefined), { what: 'the job started again', timeoutMs: 15000 });
    await waitFor(() => (h[other].prompts.length === 1 ? true : undefined), { what: 'the resumed session told' });
    await first.stop();
    expect(h[on].closed).not.toContain(paneId);

    const second = await boot(h, db.dbPath, { HOPPER_RECONNECT_GRACE_MS: '30000' });
    h[on].setUnreachable(false);
    await waitFor(() => (h[on].closed.includes(paneId) ? true : undefined), { what: 'the pane left on the lost machine closed', timeoutMs: 15000 });
    // The job's run on the other machine goes on: reattached there, never moved again, never failed.
    await second.waitForStatus(job.id, 'finished', 15000);
    const events = await ofJob(second, job.id);
    expect(events.filter((e) => e.type === 'job.parked')).toHaveLength(1);
    expect(events.find((e) => e.type === 'job.reattached')).toMatchObject({ laneId: expect.stringContaining(other) });
    expect(events.some((e) => e.type === 'job.failed')).toBe(false);
    expect(h[on].prompts).toHaveLength(1);
  });

  it('a job with no checkpoint fails as before when its machine stays away', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const h = herdrs({ seatTurns: [LONG], hostTurns: [LONG] });
    const a = await boot(h, db.dbPath);
    const pulled = await a.pull({}, item);
    const job = await waitFor(async () => {
      const j = await a.job(pulled.id);
      return j.status === 'running' && (j.executorState as { turn?: unknown } | undefined)?.turn ? j : undefined;
    }, { what: 'the job at work' });
    const on = (await ofJob(a, job.id)).find((e) => e.type === 'job.started')!.laneId!.includes('seat') ? 'seat' : 'host';
    h[on].setUnreachable(true);
    const failed = await a.waitForStatus(job.id, 'failed', 15000);
    expect(failed.error).toBe(`machine ${on} did not reconnect within 0.4 s`);
    expect((await ofJob(a, job.id)).some((e) => e.type === 'job.parked')).toBe(false);
  });
});
