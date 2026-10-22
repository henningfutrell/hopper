// Issue #2427: a job whose session finds no way to the hopper (no HOPPER_URL, no hopper-gh) ends its turn failed, as its
// job rules tell it to. Its commits were only in its worktree on that machine: a person had to bundle them off it. Now
// the hopper takes its checkpoint once more — its commits and agent session — and the job resumes on another machine
// from it, as the lost-machine move takes a job. A job with nothing to resume from fails as before. Real daemon, two
// machines, each its own fake herdr session.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, DomainEvent } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
/** Long enough (one step per poll) that the test sees which machine took the job before the turn ends. */
const NO_WAY: FakeTurn = {
  steps: Array.from({ length: 60 }, (_, i) => `● Sanding plank ${i + 1}`),
  output: ['● git push failed: HOPPER_URL is not set.', '  HOPPER_FAILED this machine cannot reach the hopper: HOPPER_URL is not set, and 5 commits are not pushed'],
};
const DONE: FakeTurn = { output: ['● Pushed the sanded planks.', '  HOPPER_DONE'] };
const item = { executor: 'herdr-claude', prompt: 'Sand the shed', env: {} };
/** A checkpoint with commits not pushed and the agent session. */
const CHECKPOINT: CheckpointCapture = {
  taken: { branch: 'hopper/shed', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
};

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

type Herdrs = Record<'seat' | 'host', FakeHerdrClient>;

const herdrs = (checkpoint: CheckpointCapture | undefined): Herdrs => ({
  seat: createFakeHerdrClient({ session: 'seat-s', turns: [NO_WAY], repositories: [`${homedir()}/shed`], ...(checkpoint ? { checkpoint } : {}) }),
  host: createFakeHerdrClient({ session: 'host-s', turns: [NO_WAY], repositories: [`${homedir()}/shed`], ...(checkpoint ? { checkpoint } : {}) }),
});

async function boot(h: Herdrs): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/shed', session: `${name}-s` } }));
  const a = await startTestApp({
    dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines },
    seams: { herdr: h.seat, herdrSessions: { 'seat-s': h.seat, 'host-s': h.host }, herdrSession: async () => {}, levels: [] },
  });
  apps.push(a);
  return a;
}

const ofJob = async (a: TestApp, id: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === id);

/** The job pulled and started: the machine it runs on, and the other one, which plays `then`. */
async function started(a: TestApp, h: Herdrs, then: FakeTurn): Promise<{ id: string; on: 'seat' | 'host'; other: 'seat' | 'host' }> {
  const { id } = await a.pull({}, item);
  const laneId = await waitFor(async () => (await ofJob(a, id)).find((e) => e.type === 'job.started')?.laneId, { what: 'the job started' });
  const on = laneId.includes('seat') ? 'seat' : 'host';
  const other = on === 'seat' ? 'host' : 'seat';
  h[other].setTurns(then);
  return { id, on, other };
}

describe('a session with no way to the hopper (issue #2427)', () => {
  it('resumes on another machine from a checkpoint taken at its end, its commits kept, and does not fail', async () => {
    const h = herdrs(CHECKPOINT);
    const a = await boot(h);
    const { id, on, other } = await started(a, h, DONE);
    const done = await a.waitForStatus(id, 'finished', 15000);
    expect(done.parked).toBeUndefined();
    const events = await ofJob(a, id);
    expect(events.some((e) => e.type === 'job.failed')).toBe(false);
    // Its checkpoint taken after the failed turn, then the move: from it, to another machine.
    const parkedAt = events.findIndex((e) => e.type === 'job.parked');
    expect(events.findIndex((e) => e.type === 'job.checkpointed')).toBeGreaterThan(-1);
    expect(events.findIndex((e) => e.type === 'job.checkpointed')).toBeLessThan(parkedAt);
    expect(events[parkedAt]!.data).toMatchObject({ from: 'running', machineId: on, auto: true, move: 'lost_machine', why: expect.stringMatching(/its session on .* had no way to the hopper: this machine cannot reach the hopper: HOPPER_URL is not set/) });
    expect(events.find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued', elsewhere: true });
    expect(events.filter((e) => e.type === 'job.started').map((e) => e.laneId)).toEqual([expect.stringContaining(on), expect.stringContaining(other)]);
    // Restored on the other machine, in the same session: the task never sent twice.
    expect(h[other].restores).toHaveLength(1);
    expect(h[other].prompts).toHaveLength(1);
    expect(h[other].prompts[0]!.text).toContain('had no way to the hopper');
    expect(h[other].prompts[0]!.text).not.toContain('Sand the shed');
  }, 30_000);

  it('a job with no checkpoint to resume from fails as before', async () => {
    const h = herdrs(undefined);
    const a = await boot(h);
    const { id } = await started(a, h, DONE);
    const failed = await a.waitForStatus(id, 'failed', 15000);
    expect(failed.error).toMatch(/this machine cannot reach the hopper: HOPPER_URL is not set/);
    expect((await ofJob(a, id)).some((e) => e.type === 'job.parked')).toBe(false);
  }, 30_000);
});
