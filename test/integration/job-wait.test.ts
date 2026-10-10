// Issue #483: a job blocked on something only a person or the outside world can do says what it waits for
// (HOPPER_WAITING). It waits as `waiting_on`: no question opens, its lane frees, its pane and Claude stay, and
// nothing is typed into it. It goes on when Claude goes on by itself (its own background check woke it) or when a
// person ends the wait. Real daemon over the fake herdr, as herdr-pane-answer.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = {
  output: ['● The fix is committed. The push needs write access.', '  HOPPER_WAITING', '  for: write access to the repository', '  until: a background poll of the push'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● Access granted. Pushed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300 } }];
const item = { executor: 'herdr-claude', prompt: 'Fix the bug', cwd: '/tmp', env: {} };

async function start(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);
const lanesNow = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];

async function waiting(a: TestApp, herdr: FakeHerdrClient): Promise<Job> {
  const job = await a.pull({}, item);
  const w = await a.waitForStatus(job.id, 'waiting_on', 8000);
  expect(herdr.prompts).toHaveLength(1);
  return w;
}

describe('a job that waits on what it named', () => {
  it('waits as waiting_on: no question, its lane free, shown with what it waits for; nothing is typed into it', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);
    expect(job.wait).toEqual({ for: 'write access to the repository', until: 'a background poll of the push', since: expect.any(String) });
    expect(job.laneId).toBeUndefined();
    expect(job.questionId).toBeUndefined();
    expect(job.resumeOn).toBe('local');
    expect(await a.questionsOf(job.id)).toEqual([]);
    expect((await lanesNow(a)).every((l) => l.state === 'idle')).toBe(true);
    const queue = (await a.api('GET', '/api/queue')).body as { waitingOn: Job[]; waitingAnswer: Job[] };
    expect(queue.waitingOn.map((j) => j.id)).toEqual([job.id]);
    expect(queue.waitingAnswer).toEqual([]);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.waiting')!.data).toEqual({ for: 'write access to the repository', until: 'a background poll of the push' });
    // Well past the nudge time: still waiting, never nudged.
    await new Promise((r) => setTimeout(r, 1000));
    expect((await a.job(job.id)).status).toBe('waiting_on');
    expect(herdr.prompts).toHaveLength(1);
  });

  it('claude going on by itself ends the wait: the job runs again on a lane and finishes; the hopper types nothing', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);

    herdr.wake((job.executorState as { agentName: string }).agentName);

    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.wait).toBeUndefined();
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Access granted. Pushed.') });
    expect(herdr.prompts).toHaveLength(1);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.reattached')!.data).toEqual({ reason: 'the wait ended in the pane' });
  });

  it('a person ends the wait: the job is told so in its pane, with the note, and finishes', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const a = await start(herdr);
    const token = await a.login();
    const job = await waiting(a, herdr);

    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/end-wait`, { note: 'Write access is granted.' }, { token });

    expect(r.status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain('write access to the repository');
    expect(herdr.prompts[1]!.text).toContain('Write access is granted.');
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'person', note: 'Write access is granted.' });
  });

  it('ending the wait of a job that does not wait is refused', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const a = await start(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect((await a.ui(`/ui/api/jobs/${job.id}/end-wait`, {}, { token })).status).toBe(409);
  });

  it('a waiting job can be cancelled: its pane closes', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const a = await start(herdr);
    const token = await a.login();
    const job = await waiting(a, herdr);

    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);

    await a.waitForStatus(job.id, 'cancelled', 8000);
    expect(herdr.prompts).toHaveLength(1);
  });
});
