// Issue #483: a job blocked on something only a person or the outside world can do says what it waits for
// (HOPPER_WAITING). It waits as `waiting_on`: no question opens, its lane frees, its pane and Claude stay, and
// nothing is typed into it. It goes on when Claude goes on by itself (its own background check woke it) or when a
// person ends the wait. Real daemon over the fake herdr, as herdr-pane-answer.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { LOST_NOTE } from '../../src/executors/herdr/restored.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = {
  output: ['● The fix is committed. The push needs write access.', '  HOPPER_WAITING', '  for: write access to the repository', '  until: a background poll of the push'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● Access granted. Pushed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Fix the bug', cwd: '/tmp', env: {} };

async function start(herdr: FakeHerdrClient, env?: Record<string, string>): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] }, ...(env ? { env } : {}) });
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
    const on = { kind: 'outside', what: 'write access to the repository' };
    expect(job.wait).toMatchObject({ for: 'write access to the repository', until: 'a background poll of the push', on, since: expect.any(String) });
    expect(Object.keys(job.wait!).filter((k) => k !== 'check').sort()).toEqual(['for', 'on', 'since', 'until']);
    expect(job.laneId).toBeUndefined();
    expect(job.questionId).toBeUndefined();
    expect(job.resumeOn).toBe('local');
    expect(await a.questionsOf(job.id)).toEqual([]);
    expect((await lanesNow(a)).every((l) => l.state === 'idle')).toBe(true);
    const queue = (await a.api('GET', '/api/queue')).body as { waitingOn: Job[]; waitingAnswer: Job[] };
    expect(queue.waitingOn.map((j) => j.id)).toEqual([job.id]);
    expect(queue.waitingAnswer).toEqual([]);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.waiting')!.data).toEqual({ for: 'write access to the repository', until: 'a background poll of the push', on });
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

  it('a job waiting on a pull request\'s merge goes on when it merges (issue #1245): the hopper tells it, on the event', async () => {
    const PR = 'https://github.com/o/r/pull/12';
    const onPr = { output: ['● The fix needs the base change first.', '  HOPPER_WAITING', '  for: the base change to land', '  on: o/r#12 merge'] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [onPr, DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);
    expect(job.wait!.on).toEqual({ kind: 'pull_request', repo: 'o/r', number: 12, about: 'merge' });

    const { store } = a.user();
    const other = store.jobs.create({ executor: 'test', payload: {} }, 50);
    store.events.append({ type: 'job.pull_request_merged', jobId: other.id, data: { pullRequest: 'https://github.com/o/r/pull/13', part: false } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await a.job(job.id)).status).toBe('waiting_on');

    store.events.append({ type: 'job.pull_request_merged', jobId: other.id, data: { pullRequest: PR, part: false } });

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain(`${PR} was merged`);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'hopper', note: `${PR} was merged` });
  });

  it('a job names its check on a check: line (issue #1694): kept with its wait, so its wait check checks then', async () => {
    const onPr = { output: ['● The checks run.', '  HOPPER_WAITING', '  for: the checks of the pull request', '  on: o/r#12 checks', '  check: in 20m'] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [onPr, DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);
    expect(job.wait).toMatchObject({ on: { kind: 'pull_request', repo: 'o/r', number: 12, about: 'checks' }, checkLine: 'in 20m' });
  });

  it('a job waiting on an issue the ledger holds closed already goes on at once (issue #1356): no event comes for it now', async () => {
    const ISSUE = 'https://github.com/o/r/issues/45';
    const herdr = createFakeHerdrClient({ session: 'jh-test' });
    const a = await start(herdr);
    const { store } = a.user();
    const card = { source: 'gh', key: ISSUE, hash: 'a'.repeat(64), author: 'someone' };
    store.events.append({ type: 'source.request_opened', data: { ...card, why: ['not a trusted actor'] } });
    store.events.append({ type: 'work_item.issue_closed', data: { key: ISSUE, reason: 'completed', via: 'landing' } });
    expect(store.workItems.get(ISSUE)).toMatchObject({ issueState: 'closed' });
    herdr.addTurns({ output: ['● The work is merged; its batch run closes the issue.', '  HOPPER_WAITING', '  for: the issue to close', '  on: issue o/r#45'] }, DONE);

    const job = await a.pull({}, item);

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts[1]!.text).toContain(`${ISSUE} was closed`);
    const events = await ofJob(a, job.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['job.waiting', 'job.wait_ended']));
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'hopper', note: `${ISSUE} was closed` });
  });

  it('a job waiting on another job goes on when that job ends (issue #1245): on the event, never a poll', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test' });
    const a = await start(herdr);
    const { store } = a.user();
    const other = store.jobs.create({ executor: 'test', payload: {} }, 50);
    herdr.addTurns({ output: ['● The fix needs the other job first.', '  HOPPER_WAITING', '  for: the other job to end', `  on: job ${other.id}`] }, DONE);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'waiting_on', 8000);
    expect((await a.job(job.id)).wait!.on).toEqual({ kind: 'job', jobId: other.id });

    store.events.append({ type: 'job.finished', jobId: other.id, data: { result: {} } });

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts[1]!.text).toContain(`job ${other.id} finished`);
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'hopper', note: `job ${other.id} finished` });
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

// Issue #1037: a wait whose until names the job's own background command waits on nothing outside the job. It runs: not
// the outside world. When the command is gone and the agent did not go on within the grace, it is nudged once, then stuck.
const OWN = (background: { work: string; polls: number; wakes?: boolean }) => ({
  output: ['● The tests run in the background.', '  HOPPER_WAITING', '  for: the test run to end', '  until: background command b7x2 ends'],
  background,
});
const GRACE = { HOPPER_OWN_COMMAND_GRACE_MS: '300' };

describe('a job that waits on its own background command (issue #1037)', () => {
  it('is marked as its own command, and is not nudged while the command runs', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [OWN({ work: '1 shell', polls: 1_000_000 }), DONE] });
    const a = await start(herdr, GRACE);
    const job = await waiting(a, herdr);
    expect(job.wait).toMatchObject({ for: 'the test run to end', until: 'background command b7x2 ends', ownCommand: true });
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.waiting')!.data).toEqual({ for: 'the test run to end', until: 'background command b7x2 ends', on: { kind: 'own_command' }, ownCommand: true });
    await new Promise((r) => setTimeout(r, 1200));
    const still = await a.job(job.id);
    expect(still.status).toBe('waiting_on');
    expect(still.wait?.nudgedAt).toBeUndefined();
    expect(herdr.prompts).toHaveLength(1);
  });

  it('its command only polls the hopper (issue #1210): its wait says what it polls, then the hopper ends it after an hour', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [OWN({ work: '1 shell', polls: 1_000_000 }), DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);
    const { engine, store } = a.user();
    const on = { kind: 'pull_request' as const, repo: 'octo/tools', number: 8, about: 'merge' as const };

    engine.pollSeen(job.id, on, '{"mergeable":"conflicts"}');
    engine.pollSeen(job.id, on, '{"mergeable":"conflicts"}');
    const typed = await a.job(job.id);
    expect(typed.status).toBe('waiting_on');
    expect(typed.wait).toMatchObject({ ownCommand: true, on, polledAt: expect.any(String) });
    expect((await ofJob(a, job.id)).filter((e) => e.type === 'job.wait_polled').map((e) => e.data)).toEqual([{ on }]);

    store.jobs.update(job.id, { wait: { ...typed.wait!, since: new Date(Date.now() - 61 * 60_000).toISOString() } });
    engine.pollSeen(job.id, on, '{"mergeable":"conflicts"}');
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.wait).toBeUndefined();
    expect(herdr.prompts[1]!.text).toContain('octo/tools#8 to merge');
    expect(herdr.prompts[1]!.text).toContain('{"mergeable":"conflicts"}');
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.wait_ended')!.data).toMatchObject({ by: 'hopper' });
  });

  it('a command gone without the agent going on: nudged once, and the job goes on', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [OWN({ work: '1 shell', polls: 2, wakes: false }), DONE] });
    const a = await start(herdr, GRACE);
    const job = await waiting(a, herdr);

    const done = await a.waitForStatus(job.id, 'finished', 8000);

    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain('background command b7x2 ends');
    const events = await ofJob(a, job.id);
    expect(events.filter((e) => e.type === 'job.own_command_nudged')).toHaveLength(1);
    expect(events.find((e) => e.type === 'job.own_command_nudged')!.data).toEqual({ delivered: true });
    expect(events.find((e) => e.type === 'job.reattached')!.data).toEqual({ reason: 'the wait ended in the pane' });
    expect(done.wait).toBeUndefined();
  });

  it('a wait flagged stuck before (issue #1694): its wait check ends it once the command is gone, and the job goes on, told why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [OWN({ work: '1 shell', polls: 3, wakes: false }), DONE] });
    const a = await start(herdr, GRACE);
    const job = await waiting(a, herdr);
    const { check: _check, ...wait } = (await a.job(job.id)).wait!;
    a.user().store.jobs.update(job.id, { wait: { ...wait, nudgedAt: wait.since, stuckAt: wait.since } });

    const done = await a.waitForStatus(job.id, 'finished', 8000);

    expect(done.wait).toBeUndefined();
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'hopper', note: 'its command is gone, and you did not go on', check: 'command_exited' });
    expect(herdr.prompts[1]!.text).toContain('The hopper ended your wait on your own command');
  });

  it('its pane lost (issue #1508): the hopper ends the wait, and the job resumes its session in a new pane, told why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [OWN({ work: '1 shell', polls: 1_000_000 }), DONE] });
    const a = await start(herdr, GRACE);
    const job = await waiting(a, herdr);
    const first = job.executorState as { agentName: string; paneId: string };
    herdr.killAgent(first.agentName);

    const done = await a.waitForStatus(job.id, 'finished', 8000);

    expect(done.wait).toBeUndefined();
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.wait_ended')!.data).toEqual({ by: 'hopper', note: 'its pane was lost' });
    expect(events.filter((e) => e.type === 'job.own_command_nudged' || e.type === 'job.own_command_stuck')).toEqual([]);
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume']));
    expect(herdr.agentStarts[1]!.paneId).not.toBe(first.paneId);
    expect(herdr.prompts[1]!.text).toContain(LOST_NOTE);
    expect(herdr.prompts[1]!.text).toContain('your pane was lost');
  });

  it('a wait on an outside event (issue #2338): its pane lost, it is not woken; a person ends the wait', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const a = await start(herdr);
    const job = await waiting(a, herdr);
    expect(job.wait?.on).toEqual({ kind: 'outside', what: 'write access to the repository' });
    herdr.killAgent((job.executorState as { agentName: string }).agentName);

    await waitFor(async () => (await a.job(job.id)).wait?.strandedAt, { what: 'its lost pane seen' });
    expect((await a.job(job.id)).status).toBe('waiting_on');
    expect((await ofJob(a, job.id)).filter((e) => e.type === 'job.wait_ended')).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);

    const admin = await a.login();
    expect((await a.ui(`/ui/api/jobs/${job.id}/end-wait`, {}, { token: admin })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.wait_ended')!.data).toMatchObject({ by: 'person' });
    expect(herdr.prompts[1]!.text).toContain('A person ended your wait');
  });
});
