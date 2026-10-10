// Auto-park (issue #650): a question that waits on a person past the park timeout parks its job by itself, the way
// the Park button does — the lane frees, the session and work tree are kept. The timer starts when the question
// reaches a person; time at the escalation levels does not count. The answer re-queues the job, which resumes its
// saved session. The timeouts are settings (GET /api/auto-park, POST /ui/api/auto-park); 0 turns auto-park off.
// A question a risk rule sent to a person never parks by itself. Real daemon over the fake herdr, as park.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { LevelReply } from '../../src/domain/ports.ts';
import type { AutoParkSettings, DomainEvent, EscalationLevel, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

const ask = (text: string) => ({ output: [`● ${text}`, '  HOPPER_QUESTION'] });
const ASK = ask('Which colour should the shed be?');
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const HIGH = { priority: 80, priorityReason: 'label:hopper:high' };
/** 0.3 s, in minutes. */
const SHORT = 0.005;

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

const setAutoPark = (a: TestApp, token: string, body: Partial<AutoParkSettings>) => a.ui<AutoParkSettings>('/ui/api/auto-park', body, { token });
const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('auto-park', () => {
  it('the settings default to 30 minutes for both; an admin changes them, and the change is an event', async () => {
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }));
    const token = await a.login();
    expect((await a.api('GET', '/api/auto-park')).body).toEqual({ minutes: 30, highPriorityMinutes: 30 });
    const r = await setAutoPark(a, token, { highPriorityMinutes: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ minutes: 30, highPriorityMinutes: 10 });
    expect((await a.events('types=auto_park.settings_changed'))[0]!.data).toMatchObject({ from: { minutes: 30, highPriorityMinutes: 30 }, to: { minutes: 30, highPriorityMinutes: 10 } });
    expect((await setAutoPark(a, token, { minutes: -1 })).status).toBe(400);
    expect((await setAutoPark(a, token, {})).status).toBe(400);
  });

  it('a question that waits past the timeout parks its job: the lane frees, a queued job starts, the card and event say why', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    await setAutoPark(a, token, { minutes: SHORT });
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');

    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    expect(parked.laneId).toBeUndefined();
    expect(parked.questionId).toBe(q.id);
    expect(parked.parked).toMatchObject({ from: 'waiting_answer', auto: true, why: 'Parked automatically: the question waited 0.3 s.' });
    expect(new Date(parked.parked!.at).getTime() - new Date(q.escalatedToHumanAt!).getTime()).toBeGreaterThanOrEqual(300);
    const event = (await ofJob(a, job.id)).find((e) => e.type === 'job.parked')!;
    expect(event.data).toEqual({ from: 'waiting_answer', machineId: 'local', auto: true, why: 'Parked automatically: the question waited 0.3 s.' });
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
    await setAutoPark(a, token, { minutes: SHORT, highPriorityMinutes: SHORT });
    const job = await a.pull({}, { ...item, ...HIGH });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    await waitFor(() => herdr.closed.length === 1, { what: 'the pane closed' });

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    expect(done.priority).toBe(80);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'Blue.']);
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued' });
  });

  it('time at the escalation levels does not count; a question the frontier level answers never parks', async () => {
    // The level takes longer than the timeout, then answers the colour sure of it and sends the size up.
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
    const token = await a.login();
    await setAutoPark(a, token, { minutes: SHORT });
    const job = await a.pull({}, item);
    const second = await a.waitForQuestion(job.id, (x) => /big/.test(x.text) && x.tier === 'human', 8000);
    const types = (await ofJob(a, job.id)).map((e) => e.type);
    expect(types).not.toContain('job.parked');
    const [first] = (await a.questionsOf(job.id)).filter((x) => /colour/.test(x.text));
    expect(first).toMatchObject({ status: 'answered', answeredBy: 'frontier' });

    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    expect(new Date(parked.parked!.at).getTime() - new Date(second.escalatedToHumanAt!).getTime()).toBeGreaterThanOrEqual(300);
  });

  it('a timeout of 0 turns auto-park off', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    await setAutoPark(a, token, { minutes: 0, highPriorityMinutes: SHORT });
    const job = await a.pull({}, item);
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await sleep(800);
    expect((await a.job(job.id)).status).toBe('waiting_answer');
  });

  it('a high-priority job uses the high-priority timeout', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await boot(herdr);
    const token = await a.login();
    await setAutoPark(a, token, { minutes: 60, highPriorityMinutes: SHORT });
    const job = await a.pull({}, { ...item, ...HIGH });
    await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    expect(parked.parked!.why).toBe('Parked automatically: the question waited 0.3 s.');
  });

  it('a question a risk rule sent to a person keeps its job waiting in its pane', async () => {
    const frontier = createFakeLevel({ name: 'frontier', script: (): LevelReply => ({ answer: 'Yes.', escalate: false, reason: 'fine', confidence: 'high' }) });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ask('May I delete the old branch?'), DONE] });
    const a = await boot(herdr, [frontier]);
    const token = await a.login();
    await setAutoPark(a, token, { minutes: SHORT });
    const job = await a.pull({}, item);
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[0]!.riskRules).toEqual(['delete']);
    await sleep(800);
    const still: Job = await a.job(job.id);
    expect(still.status).toBe('waiting_answer');
    expect(still.parked).toBeUndefined();
    expect(herdr.closed).toHaveLength(0);
  });
});
