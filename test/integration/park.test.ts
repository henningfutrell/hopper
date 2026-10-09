// Parking a job (issue #501): a person takes a running or question-waiting job out of its lane for an open-ended
// time. Its lane frees at once, its pane and agent end, and its work tree, branch, agent session, machine and open
// question are kept. Re-queued, it returns pinned to its machine, and its executor resumes the same agent session
// in a new pane (`claude --resume <session>`), never a fresh one. Real daemon over the fake herdr, as
// herdr-pane-answer.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
/** A turn that never ends by itself: the job is mid-turn when it is parked. */
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function boot(herdr: FakeHerdrClient, o: { dbPath?: string; env?: Record<string, string>; laneCount?: number } = {}): Promise<TestApp> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    dbPath = db.dbPath;
  }
  const a = await startTestApp({ dbPath, env: o.env, plugins: { executors: EXECUTORS, machines: lanes(o.laneCount ?? 1) }, seams: { herdr, levels: [] } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);
const park = (a: TestApp, token: string, id: string) => a.ui<Job>(`/ui/api/jobs/${id}/park`, {}, { token });
const requeue = (a: TestApp, token: string, id: string) => a.ui<Job>(`/ui/api/jobs/${id}/requeue`, {}, { token });
const lanesNow = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines[0].lanes as { id: string; state: string; jobId?: string }[];

describe('parking a running job', () => {
  it('frees its lane at once, ends its pane and agent, and keeps its work tree and session', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const running = await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    const session = (await a.job(job.id)).agentSession;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(herdr.agentStarts[0]!.args).toEqual(expect.arrayContaining(['--session-id', session!]));

    const r = await park(a, token, job.id);
    expect(r.status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked.laneId).toBeUndefined();
    expect(parked.resumeOn).toBe('local');
    expect(parked.parked).toMatchObject({ from: 'running' });
    expect(parked.agentSession).toBe(session);
    expect((await lanesNow(a)).filter((l) => l.jobId === job.id)).toEqual([]);
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    // Its processes stop; its scratch dir, where its worktree lives, is never named to the reap.
    expect(herdr.reaps).toEqual([{ jobId: job.id }]);
    const types = (await ofJob(a, job.id)).map((e) => e.type);
    expect(types).toContain('job.parked');
    expect(types).not.toContain('job.failed');
    expect(types).not.toContain('job.cancelled');
    expect((await a.events('types=job.parked'))[0]!.data).toEqual({ from: 'running', machineId: 'local' });
    expect(running.laneId).toBeDefined();

    // The machine takes another job on the freed lane.
    const other = await a.pull({ op: 'echo', message: 'next' });
    await a.waitForStatus(other.id, 'finished');
    expect((await a.job(job.id)).status).toBe('parked');
  });

  it('re-queued, it returns to its machine and resumes the same agent session in a new pane', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    const session = (await a.job(job.id)).agentSession!;

    const r = await requeue(a, token, job.id);
    expect(r.status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed blue.') });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.agentStarts[1]!.args).not.toContain('--session-id');
    // The task is not sent again: the resumed session is told to go on.
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).not.toContain('Paint the shed');
    expect(herdr.prompts[1]!.text).toContain('parked');
    const events = await ofJob(a, job.id);
    expect(events.find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued' });
    expect(done.parked).toBeUndefined();
  });

  it('is refused for a job that is not running or on a question, and for one whose executor cannot park', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [] });
    const a = await boot(herdr);
    const token = await a.login();
    const sleeper = await a.pull({ op: 'sleep', ms: 3000 });
    await a.waitForStatus(sleeper.id, 'running');
    const r = await park(a, token, sleeper.id);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('cannot park');
    const waiting = await a.pull({ op: 'echo', message: 'x' });
    expect((await park(a, token, waiting.id)).status).toBe(409);
    expect((await requeue(a, token, sleeper.id)).status).toBe(409);
  });
});

describe('parking a job on a question', () => {
  it('keeps its question open and answerable past the human timeout; the answer waits for the re-queue', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr, { env: { HOPPER_HUMAN_TIMEOUT_MS: '300', HOPPER_HUMAN_RENOTIFY_MS: '100' } });
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');

    expect((await park(a, token, job.id)).status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked.parked).toMatchObject({ from: 'waiting_answer' });
    expect(parked.questionId).toBe(q.id);
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    // Past the human timeout: nothing expires, nothing fails.
    await new Promise((r) => setTimeout(r, 800));
    expect((await a.job(job.id)).status).toBe('parked');
    const [open] = await a.questionsOf(job.id);
    expect(open!.status).toBe('open');
    expect((await a.api('GET', '/api/questions')).body.questions.map((x: { id: string }) => x.id)).toContain(q.id);

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    const kept = await a.job(job.id);
    expect(kept.status).toBe('parked');
    expect(kept.pendingAnswer).toBe('Blue.');

    expect((await requeue(a, token, job.id)).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'Blue.']);
  });

  it('re-queued while its question is still open, it waits on the question again; the answer resumes its session', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    const r = await requeue(a, token, job.id);
    expect(r.body.status).toBe('waiting_answer');
    expect((await a.events('types=job.unparked'))[0]!.data).toEqual({ to: 'waiting_answer' });
    await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', (await a.job(job.id)).agentSession!]));
  });

  it('cancelled while parked, its question is cancelled and the normal reap releases its scratch dir', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.reaps.length === 1, { what: 'the park reap' });

    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'cancelled');
    await waitFor(() => herdr.reaps.length === 2, { what: 'the cancel reap' });
    expect(herdr.reaps[1]).toEqual({ jobId: job.id, scratch: expect.stringMatching(new RegExp(`/\\.hopper-scratch/${job.id}$`)) });
    expect((await a.questionsOf(job.id))[0]!.status).toBe('cancelled');
  });
});

describe('a job whose executor recorded no agent session (issue #530: started before #510)', () => {
  /** A job on a question, as one started before agent sessions were recorded: no `agentSession`. */
  async function onQuestionWithoutSession(herdr: FakeHerdrClient) {
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    a.user().store.jobs.update(job.id, { agentSession: undefined });
    expect((await a.job(job.id)).agentSession).toBeUndefined();
    return { a, token, job, q };
  }

  it('is parked from its question: the machine stops counting it and takes a new job at once', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK] });
    const { a, token, job, q } = await onQuestionWithoutSession(herdr);
    // On its question its pane is live on the machine: the machine keeps it, though it holds no lane.
    expect(a.user().engine.jobsOnMachine('local')).toContain(job.id);
    expect((await lanesNow(a)).filter((l) => l.jobId === job.id)).toEqual([]);

    expect((await park(a, token, job.id)).status).toBe(200);
    const parked = await a.waitForStatus(job.id, 'parked');
    expect(parked).toMatchObject({ resumeOn: 'local', questionId: q.id, parked: { from: 'waiting_answer' } });
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    // Its work tree is kept: the reap names no scratch dir.
    expect(herdr.reaps).toEqual([{ jobId: job.id }]);
    expect(a.user().engine.jobsOnMachine('local')).not.toContain(job.id);
    expect((await a.questionsOf(job.id))[0]!.status).toBe('open');

    const other = await a.pull({ op: 'echo', message: 'next' });
    await a.waitForStatus(other.id, 'finished');
    expect((await a.job(job.id)).status).toBe('parked');
  });

  it('re-queued, it starts fresh only once the person confirms: a new session in the kept work tree, the question and its answer as context', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const { a, token, job, q } = await onQuestionWithoutSession(herdr);
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token });

    // Never fresh silently: without the confirmation the re-queue is refused, and the job stays parked.
    const refused = await requeue(a, token, job.id);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('fresh');
    expect((await a.job(job.id)).status).toBe('parked');

    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, { freshSession: true }, { token });
    expect(r.status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed blue.') });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).not.toContain('--resume');
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--session-id', done.agentSession!]));
    // In the kept work tree: the new pane opens where the first one did.
    const tabs = herdr.calls.filter((x) => x.method === 'createTab').map((x) => (x.args[0] as { cwd: string }).cwd);
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toBe(tabs[0]);
    const prompt = herdr.prompts[1]!.text;
    expect(prompt).toContain('Paint the shed');
    expect(prompt).toContain('Which colour should the shed be?');
    expect(prompt).toContain('Blue.');
    expect(prompt).toContain('fresh');
  });

  it('re-queued with its question still open, it waits on it again; the answer then starts it fresh with the question as context', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const { a, token, job, q } = await onQuestionWithoutSession(herdr);
    await park(a, token, job.id);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    expect((await requeue(a, token, job.id)).status).toBe(409);
    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, { freshSession: true }, { token });
    expect(r.body.status).toBe('waiting_answer');
    await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts[1]!.args).not.toContain('--resume');
    expect(herdr.prompts[1]!.text).toContain('Which colour should the shed be?');
    expect(herdr.prompts[1]!.text).toContain('Blue.');
  });

  it('the health read names the executors that can park, so the UI offers Park only where the daemon takes it', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [] });
    const a = await boot(herdr);
    expect((await a.api('GET', '/api/health')).body.parkingExecutors).toEqual(['herdr-claude']);
  });
});

describe('a restart while parked', () => {
  it('keeps the job parked with its session; re-queued after, it resumes that session', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const first = await boot(herdr);
    const token = await first.login();
    const job = await first.pull({}, item);
    await first.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    await park(first, token, job.id);
    await first.waitForStatus(job.id, 'parked');
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    const session = (await first.job(job.id)).agentSession!;
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    // The machine still has the job's scope and its scratch dir, older than the sweep's age.
    const scratch = `/tmp/.hopper-scratch/${job.id}`;
    const there = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], survey: { scopes: [job.id], processes: [], scratch: [{ jobId: job.id, path: scratch, ageMs: 99 * 3600_000 }] } });
    const second = await boot(there, { dbPath: first.dbPath });
    const after = await second.job(job.id);
    expect(after).toMatchObject({ status: 'parked', agentSession: session, resumeOn: 'local' });
    // The restart's sweep stops what still runs of it, and keeps its scratch dir.
    await waitFor(() => there.reaps.length === 1, { what: 'the sweep' });
    expect(there.reaps).toEqual([{ jobId: job.id }]);
    const token2 = await second.login();
    expect((await requeue(second, token2, job.id)).status).toBe(200);
    await second.waitForStatus(job.id, 'finished', 8000);
    expect(there.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session]));
  });
});
