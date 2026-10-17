// The signed-out move (issue #1211): a job held on a not-signed-in question on a machine whose Claude reads signed out goes
// on at another machine that reads Claude signed in, with no person. Its question is answered by the move, its pane on the
// old machine ends, and it resumes on the new one: from its checkpoint, or as a new start when its agent never got its task.
// Real daemon over the fake herdr: the machine `seat`'s account is a usage source at the seam the test sets, `host`'s the
// claude-plan source against the fake claude, signed in from the hopper.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettableUsageSource } from '../../src/domain/ports.ts';
import { SIGNED_OUT_MOVE_BY, signedOutMoveAnswer, type Account, type CheckpointCapture, type DomainEvent, type Job, type LoginView, type ToolAccount } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} };
const BASE = 'b'.repeat(40);
/** A checkpoint of a job whose Claude never got its task: no session, no commit, no change. */
const UNTOUCHED: CheckpointCapture = { taken: { branch: 'hopper/shed', base: BASE, head: BASE, commits: [], patch: gzipSync('') } };
/** One with work: a commit not pushed, no session. */
const WORKED: CheckpointCapture = { taken: { branch: 'hopper/shed', base: BASE, head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'], patch: gzipSync('') } };

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
const saved = process.env.FAKE_PLAN_DIR;
let control: string;

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-fake-plan-'));
  process.env.FAKE_PLAN_DIR = control;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
});

/** The account the usage source of `seat` reads: signed in until the test signs it out. */
function seatSource(): SettableUsageSource & { signOut(): void } {
  let account: Account = { service: 'claude', identity: 'seat@example.com', detail: { machine: 'seat' } };
  return {
    name: 'claude-seat', poll: async () => [], set: () => [],
    state: () => ({ account, accountReadAt: new Date().toISOString(), executors: ['herdr-claude'] }),
    signOut: () => { account = { service: 'claude', detail: { machine: 'seat' }, problem: 'not logged in', signedOut: true }; },
  };
}

async function boot(herdr: FakeHerdrClient, seat: SettableUsageSource): Promise<TestApp> {
  // `host` reads signed out at first, so the job goes to `seat`.
  writeFileSync(join(control, 'mode'), 'logged-out');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const machines = ['seat', 'host'].map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }));
  const a = await startTestApp({
    dbPath: db.dbPath,
    plugins: { executors: EXECUTORS, machines, usageSources: [{ name: 'claude-host', plugin: 'claude-plan', options: { machine: 'host', bin: FAKE_CLAUDE, executors: ['herdr-claude'] } }] },
    // Each user's fake usage is set per user: `seat`'s account is the test's.
    seams: { herdr, levels: [], perUser: () => ({ fakeUsage: seat }) },
  });
  apps.push(a);
  // Read signed out before the job is pulled, so the decider places it on `seat`.
  await waitFor(async () => {
    const accounts = (await a.api<{ accounts: ToolAccount[] }>('GET', '/api/tool-accounts')).body.accounts;
    return accounts.some((x) => x.machines.some((m) => m.machineId === 'host' && m.login === 'signed-out')) ? true : undefined;
  }, { what: 'host read signed out' });
  return a;
}

/** Sign Claude in on `host` from the hopper: its source reads it again at once. */
async function signInHost(a: TestApp, token: string): Promise<void> {
  const login = (await a.ui<LoginView>('/ui/api/tool-accounts/sign-in', { source: 'claude-host' }, { token })).body;
  expect((await a.ui<LoginView>(`/ui/api/logins/${login.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');
}

/** A job held on a not-signed-in question on `seat`. */
async function heldOnSeat(a: TestApp) {
  const job = await a.pull({}, item);
  const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human' && x.text.startsWith('Claude is not signed in'));
  expect(q.raisedBy?.machineId).toBe('seat');
  return { job, q };
}

const ofJob = async (a: TestApp, id: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === id);

describe('the signed-out move', () => {
  it('a job whose Claude never got its task starts again on the signed-in machine, its question answered by the move', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', notSignedIn: true, turns: [DONE], repositories: [`${homedir()}/shed`], checkpoint: UNTOUCHED });
    const seat = seatSource();
    const a = await boot(herdr, seat);
    const token = await a.login();
    const { job, q } = await heldOnSeat(a);
    expect(herdr.prompts).toEqual([]);

    await signInHost(a, token);
    herdr.signIn();
    seat.signOut();
    const done = await a.waitForStatus(job.id, 'finished', 10000);
    expect(done.parked).toBeUndefined();

    const answered = (await a.questionsOf(job.id)).find((x) => x.id === q.id)!;
    expect(answered).toMatchObject({ status: 'answered', answeredBy: SIGNED_OUT_MOVE_BY, answer: signedOutMoveAnswer('seat', 'claude') });
    expect(answered.attempts.at(-1)).toMatchObject({ tier: SIGNED_OUT_MOVE_BY, role: 'fixed', outcome: 'accepted' });
    expect(answered.attempts.at(-1)!.reason).toBe('claude reads signed out on seat (usage source claude-seat); signed in on host');
    const events = await ofJob(a, job.id);
    expect(events.filter((e) => e.type === 'job.started').map((e) => e.laneId)).toEqual([expect.stringContaining('seat'), expect.stringContaining('host')]);
    expect(events.find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued', elsewhere: true });
    // A new start: the task, and no restore.
    expect(herdr.restores).toEqual([]);
    expect(herdr.prompts.at(-1)!.text).toContain('Paint the shed');
    expect(herdr.closed.length).toBeGreaterThanOrEqual(1);
  });

  it('a job stays on its question while no other machine reads signed in', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', notSignedIn: true, turns: [DONE], repositories: [`${homedir()}/shed`], checkpoint: UNTOUCHED });
    const seat = seatSource();
    const a = await boot(herdr, seat);
    const { job, q } = await heldOnSeat(a);
    seat.signOut();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await a.job(job.id)).status).toBe('waiting_answer');
    expect((await a.questionsOf(job.id)).find((x) => x.id === q.id)!.status).toBe('open');
  });

  it('a job whose checkpoint holds work but no agent session stays on its question for a person', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', notSignedIn: true, turns: [DONE], repositories: [`${homedir()}/shed`], checkpoint: WORKED });
    const seat = seatSource();
    const a = await boot(herdr, seat);
    const token = await a.login();
    const { job } = await heldOnSeat(a);
    await signInHost(a, token);
    seat.signOut();
    await waitFor(async () => ((await a.events('types=job.checkpointed')).some((e) => e.jobId === job.id) ? true : undefined), { what: 'the checkpoint the move took' });
    await new Promise((r) => setTimeout(r, 1000));
    const now: Job = await a.job(job.id);
    expect(now.status).toBe('waiting_answer');
  });
});
