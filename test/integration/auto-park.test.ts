// Auto-park (issues #650, #2335): a question that waits on a person parks its job by itself a few seconds after it reached
// them (WAIT_RELEASE_AFTER_MS), the way the Park button does — the lane frees, the session and work tree are kept. Time at
// the escalation levels does not count. The answer re-queues the job, which resumes its saved session; with the checkpoint
// taken after its agent ended, on any machine. No setting: a job on a question holds no agent. A question a risk rule sent to
// a person parks too, and so does a job on its proposal at the human stage, and a job a fork of its question works for. Real daemon over the fake herdr, as park.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { EscalationLevel, LevelReply } from '../../src/domain/ports.ts';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { AUTO_PARK_WHY, WAIT_RELEASE_AFTER_MS, type CheckpointCapture, type DomainEvent, type Job, type ReviewItemView } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

const ask = (text: string) => ({ output: [`● ${text}`, '  HOPPER_QUESTION'] });
const ASK = ask('Which colour should the shed be?');
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const HIGH = { priority: 80, priorityReason: 'label:hopper:high' };
const PROPOSAL = {
  output: ['● TL;DR: Paint it blue.', '  Problem: The shed is bare wood.', '  Paths: none — no change is needed now.', '  Context: the shed.', '  HOPPER_PROPOSAL'],
};
/** Long enough for a park a few seconds after the question reached a person. */
const PARKS = WAIT_RELEASE_AFTER_MS + 10_000;

async function boot(herdr: FakeHerdrClient, levels: EscalationLevel[] = []): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('auto-park', () => {
  it('a question that reaches a person parks its job a few seconds later: the lane frees, a queued job starts, the card and event say why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');

    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    expect(parked.laneId).toBeUndefined();
    expect(parked.questionId).toBe(q.id);
    expect(parked.parked).toMatchObject({ from: 'waiting_answer', auto: true, why: AUTO_PARK_WHY });
    expect(new Date(parked.parked!.at).getTime() - new Date(q.escalatedToHumanAt!).getTime()).toBeGreaterThanOrEqual(WAIT_RELEASE_AFTER_MS);
    const event = (await ofJob(a, job.id)).find((e) => e.type === 'job.parked')!;
    expect(event.data).toEqual({ from: 'waiting_answer', machineId: 'local', auto: true, why: AUTO_PARK_WHY });
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    expect((await a.questionsOf(job.id))[0]!.status).toBe('open');

    // The freed lane takes the next job.
    const other = await a.pull({ op: 'echo', message: 'next' });
    await a.waitForStatus(other.id, 'finished');
    expect((await a.job(job.id)).status).toBe('parked');
  });

  it('the answer to its question re-queues it with its priority, and it resumes its saved session', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, { ...item, ...HIGH });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.priority).toBe(80);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'Blue.']);
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued' });
  });

  it('picked up from a person\'s park, it parks again by itself; then Pick up is refused until the answer, which picks it up (issue #2415)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect((await a.ui(`/ui/api/jobs/${job.id}/park`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'parked', PARKS);

    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(r.body.status).toBe('waiting_answer');
    const again = await waitFor(async () => { const j = await a.job(job.id); return j.status === 'parked' && j.parked?.auto ? j : undefined; }, { what: 'parked again by itself', timeoutMs: PARKS });
    expect(again.parked).toMatchObject({ auto: true, why: AUTO_PARK_WHY });

    // No loop: picked up now, it would only park again.
    const refused = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('waits on its question with a person');
    await sleep(500);
    expect((await a.job(job.id)).status).toBe('parked');
    expect((await ofJob(a, job.id)).filter((e) => e.type === 'job.unparked')).toHaveLength(1);

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
  }, 30_000);

  it('picked up with a question 5 h old, it waits a few seconds again; the answer then resumes it (issue #1007)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect((await a.ui(`/ui/api/jobs/${job.id}/park`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'parked', PARKS);
    // The question reached a person 5 h ago, and never waited again since.
    const { store } = a.user();
    const old = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    store.questions.update(q.id, { escalatedToHumanAt: old, waitRestartedAt: undefined });

    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(r.body.status).toBe('waiting_answer');
    expect(store.questions.get(q.id)!.waitRestartedAt).toBeDefined();
    await sleep(1500);
    expect((await a.job(job.id)).status).toBe('waiting_answer');

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
  }, 30_000);

  it('time at the escalation levels does not count; a question the frontier level answers never parks', async () => {
    // The level takes a while, then answers the colour sure of it and sends the size up.
    const frontier = createFakeLevel({
      name: 'frontier',
      script: async (req): Promise<LevelReply> => {
        await sleep(700);
        return /colour/.test(req.question.text)
          ? { answer: 'Blue.', escalate: false, reason: 'the job settles it', confidence: 'high' }
          : { answer: 'Big.', escalate: true, reason: 'the owner\'s call', confidence: 'medium' };
      },
    });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, ask('How big should the shed be?'), DONE] });
    const a = await boot(herdr, [frontier]);
    const job = await a.pull({}, item);
    const second = await a.waitForQuestion(job.id, (x) => /big/.test(x.text) && x.tier === 'human', 8000);
    const types = (await ofJob(a, job.id)).map((e) => e.type);
    expect(types).not.toContain('job.parked');
    const [first] = (await a.questionsOf(job.id)).filter((x) => /colour/.test(x.text));
    expect(first).toMatchObject({ status: 'answered', answeredBy: 'frontier' });

    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    expect(new Date(parked.parked!.at).getTime() - new Date(second.escalatedToHumanAt!).getTime()).toBeGreaterThanOrEqual(WAIT_RELEASE_AFTER_MS);
  });

  it('a question a risk rule sent to a person parks its job too (issue #2335)', async () => {
    const frontier = createFakeLevel({ name: 'frontier', script: (): LevelReply => ({ answer: 'Yes.', escalate: false, reason: 'fine', confidence: 'high' }) });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ask('May I delete the old branch?'), DONE] });
    const a = await boot(herdr, [frontier]);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[0]!.riskRules).toEqual(['delete']);
    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    expect(parked.parked).toMatchObject({ from: 'waiting_answer', auto: true, why: AUTO_PARK_WHY });
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Yes, delete it.' }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
  });

  it('a job on its proposal parks at the human stage; it stays in Proposals, and sent back it resumes its session (issue #2335)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [PROPOSAL, PROPOSAL] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    expect(parked.parked).toMatchObject({ from: 'waiting_answer', auto: true, why: AUTO_PARK_WHY });
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });
    const open = (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=open')).body.items;
    expect(open.map((p) => p.jobId)).toEqual([job.id]);
    expect(open[0]!.parked).toBeUndefined();
    // Picked up, it would only park again (issue #2415): the decision picks it up.
    const refused = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('waits on its proposal with a person');

    expect((await a.ui(`/ui/api/proposals/${open[0]!.id}/steer`, { notes: 'Use oil paint.' }, { token })).status).toBe(200);
    await waitFor(() => herdr.prompts.length === 2, { what: 'its session resumed, told the notes', timeoutMs: 8000 });
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    expect(herdr.prompts.at(-1)!.text).toContain('Use oil paint.');
  });

  it('answered, it resumes its session on another machine from the checkpoint taken after its agent ended (issue #2335)', async () => {
    const BASE = 'b'.repeat(40);
    const checkpoint: CheckpointCapture = {
      taken: { branch: 'hopper/shed', base: BASE, head: 'c'.repeat(40), commits: [], patch: gzipSync('diff'), session: gzipSync('{"session":true}') },
    };
    const repositories = [`${homedir()}/shed`];
    const seat = createFakeHerdrClient({ session: 'seat-s', turns: [ASK], repositories, checkpoint });
    const host = createFakeHerdrClient({ session: 'host-s', turns: [DONE], repositories, checkpoint });
    const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, workTree: '~/shed', session: `${name}-s` } }));
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = await startTestApp({
      dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines },
      seams: { herdr: seat, herdrSessions: { 'seat-s': seat, 'host-s': host }, herdrSession: async () => {}, levels: [] },
    });
    apps.push(a);
    const token = await a.login();
    const drain = async (machineId: string, drained: boolean) => expect((await a.ui('/ui/api/machines/drain', { machineId, drained, ...(drained ? { reason: 'test' } : {}) }, { token })).status).toBe(200);

    await drain('host', true);
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const parked = await a.waitForStatus(job.id, 'parked', PARKS);
    const session = parked.agentSession;
    // Its checkpoint, taken after its agent ended, is marked on the park.
    const marked = await waitFor(async () => { const j = await a.job(job.id); return j.parked?.checkpointAt ? j : undefined; }, { what: 'its checkpoint marked' });
    expect(marked.parked!.checkpointAt).toBe(marked.checkpoint!.at);
    // Its pane closed: its terminal is no longer there to read.
    expect((await a.ui(`/ui/api/jobs/${job.id}/terminal/screen`, {}, { token })).status).toBe(409);

    await drain('host', false);
    await drain('seat', true);
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    const back = await a.waitForStatus(job.id, 'finished', 8000);
    expect(back.agentSession).toBe(session);
    expect((await a.events('types=job.started')).filter((e) => e.jobId === job.id).at(-1)!.laneId).toContain('host');
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued', elsewhere: true });
    expect(host.restores).toHaveLength(1);
    expect(host.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session!]));
    expect(host.prompts.at(-1)!.text).toContain('Blue.');
  });

  it('a job whose question a fork works for parks at once: its pane closes while the fork runs (issue #2335)', async () => {
    const REPORT = { output: ['● Question: what colours last?', '  Findings: blue lasts.', '  HOPPER_RESEARCH_REPORT'] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, REPORT] });
    const a = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const r = await a.ui(`/ui/api/questions/${q.id}/research`, { mode: 'fork', note: 'which colours last' }, { token });
    expect(r.status).toBe(200);
    expect((await a.job(job.id)).status).toBe('parked');
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.forked')!.data).toMatchObject({ mode: 'fork', parent: 'parked' });
    await waitFor(() => herdr.closed.length === 1, { what: 'the parent\'s pane closed' });
    expect((await a.questionsOf(job.id))[0]!.status).toBe('open');
  });

  it('a job waiting on a login is running, not on a question: it never parks by itself', async () => {
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }));
    const job = await a.pull({ op: 'sleep', ms: 30_000 });
    await a.waitForStatus(job.id, 'running');
    a.user().logins.report({ kind: 'device_code', tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + 600_000).toISOString() },
      { jobId: job.id, run: 'test', renewable: false });
    await sleep(800);
    expect((await a.job(job.id)).status).toBe('running');
    expect((await ofJob(a, job.id)).map((e) => e.type)).not.toContain('job.parked');
  });
});
