// What hopper.io would get (issue #466 part 2, design.md "The hopper.io state snapshot"): the instance makes its
// hopper.io state snapshot from its live state, every user's machines, lanes, queue and questions in one, and shows it to
// its admin in Settings → hopper.io before anything is sent. GET /api/cloud-link/state reads only. Real daemon over the
// fake herdr, as auto-park.test.ts.
//   Scenario: the admin reads the snapshot: the counts of the live queue and questions of every user, each user's machine
//     under its own key; no machine id, host name, user, job or question text in it; the schema takes it
//   Scenario: one queue gate for the instance: `review` while any user reviews new jobs
//   Scenario: only the admin reads it (403 for another user), and the read records nothing
import { hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HOPPER_IO_STATE_SCHEMA, type HopperIoState } from '../../src/domain/hopper-io-state.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const QUESTION = 'Which colour should the shed be?';
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [{ output: [`● ${QUESTION}`, '  HOPPER_QUESTION'] }] });
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  return t;
}

describe('what hopper.io would get', () => {
  it('the admin reads the snapshot of the live state: counts and each user\'s machine under its own key, nothing else', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed' });
    await a.waitForQuestion(job.id, (q) => q.tier === 'human');
    const other = await a.addUser('octo2');
    await a.addThisMachine(other.id);
    const sleeping = await a.pull({ op: 'sleep', ms: 30_000 }, undefined, other.id);
    await a.waitForStatusOf(sleeping.id, 'running', other.id);

    const r = await a.api<HopperIoState>('GET', '/api/cloud-link/state', undefined, { 'x-hopper-session': token });
    expect(r.status).toBe(200);
    expect(HOPPER_IO_STATE_SCHEMA.parse(r.body)).toEqual(r.body);
    expect(r.body).toMatchObject({
      schema: 1,
      queue: { waiting: 0, running: 1, locked: 0, gate: 'auto-accept' }, // the asking job waits on its answer, in no list counted
      attention: { questionsAwaitingOwner: 1, jobsLocked: 0, machinesOffline: 0 },
    });
    expect(r.body.machines).toEqual([
      { key: 'machine-1', online: true, lanesInUse: 0, lanes: 1, takesJobs: true },
      expect.objectContaining({ key: 'machine-2', online: true, lanesInUse: 1 }),
    ]);

    const text = JSON.stringify(r.body);
    for (const never of ['local', hostname(), 'octo2', other.id, job.id, sleeping.id, QUESTION, 'Paint the shed', '/tmp']) expect(text).not.toContain(never);
  });

  it('one queue gate for the instance: review while any user reviews new jobs', async () => {
    const a = await boot();
    const token = await a.login();
    const other = await a.addUser('octo2');
    const gate = async () => (await a.api<HopperIoState>('GET', '/api/cloud-link/state', undefined, { 'x-hopper-session': token })).body.queue.gate;
    expect(await gate()).toBe('auto-accept');
    a.user(other.id).engine.setQueueGate({ mode: 'review', autoAcceptPerHour: null });
    expect(await gate()).toBe('review');
  });

  it('only the admin reads it, and the read records nothing', async () => {
    const a = await boot();
    const token = await a.login();
    const other = await a.addUser('octo2');
    const before = (await a.events()).length;

    expect((await a.api('GET', '/api/cloud-link/state', undefined, { 'x-hopper-session': await a.login(other.id) })).status).toBe(403);
    expect((await a.api('GET', '/api/cloud-link/state', undefined, { 'x-hopper-session': token })).status).toBe(200);
    expect((await a.events()).length).toBe(before);
  });
});
