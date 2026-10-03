// Questions over the real HTTP server and SQLite file: the test executor's `ask` op and the
// fake answerers (policy in src/main.ts: opus confident unless the question says "hard" or
// "unsure"; fable confident unless "unsure"; both mark "risky" questions risky).
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createAskerExecutor } from '../support/doubles.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let receiver: Receiver | undefined;

async function start(env: Record<string, string> = {}, seams?: Parameters<typeof startTestApp>[0]['seams']): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env, ...(seams ? { seams } : {}) });
  return t;
}

afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const ask = (message: string, extra: Record<string, unknown> = {}) => ({ executor: 'test', payload: { op: 'ask', message }, ...extra });

describe('a question answered by a model tier', () => {
  it('opus accepts a plain question; the job resumes with the answer and finishes', async () => {
    const a = await start();
    const job = await a.push(ask('Which colour?', { goal: 'paint the shed' }));
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: 'fake opus answer' });
    expect(done.pendingAnswer).toBeUndefined();
    expect(done.attempts).toBe(2);

    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus', answer: 'fake opus answer', text: 'Which colour?', detectedBy: 'test' });
    expect(q!.attempts).toEqual([expect.objectContaining({ tier: 'opus', model: 'fake-opus', outcome: 'accepted', confident: true, risky: false })]);
    expect(done.questionId).toBe(q!.id);

    const events = ofJob(await a.events(), job.id);
    const types = events.map((e) => e.type);
    expect(types.indexOf('question.asked')).toBeLessThan(types.indexOf('question.answered'));
    expect(types.indexOf('question.answered')).toBeLessThan(types.indexOf('job.requeued'));
    expect(types.filter((x) => x === 'job.started')).toHaveLength(2);
    expect(types.at(-1)).toBe('job.finished');
    const asked = events.find((e) => e.type === 'question.asked')!;
    expect(asked.questionId).toBe(q!.id);
    expect(asked.data).toEqual({ questionId: q!.id, text: 'Which colour?', detectedBy: 'test' });
    expect(events.find((e) => e.type === 'job.requeued')!.data).toEqual({ from: 'waiting_answer', reason: 'answered' });
    expect(events.filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['opus']);
  });

  it('a hard question escalates to fable, which answers it', async () => {
    const a = await start();
    const job = await a.push(ask('Which hard option?'));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'fake fable answer' });
    const [q] = await a.questionsOf(job.id);
    expect(q!.answeredBy).toBe('fable');
    expect(q!.attempts.map((x) => [x.tier, x.outcome])).toEqual([['opus', 'escalated'], ['fable', 'accepted']]);
    const targets = ofJob(await a.events(), job.id).filter((e) => e.type === 'question.escalated').map((e) => e.data.target);
    expect(targets).toEqual(['opus', 'fable']);
  });

  it('fail-after-answer fails the job on resume and clears the pending answer', async () => {
    const a = await start();
    const job = await a.push({ executor: 'test', payload: { op: 'fail-after-answer', message: 'Go?' } });
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toEqual(expect.any(String));
    expect(failed.pendingAnswer).toBeUndefined();
  });
});

describe('a question escalated to the human', () => {
  it('climbs opus → fable → human, shows the trail, and a POSTed answer resumes the job', async () => {
    const a = await start();
    const job = await a.push(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.status).toBe('open');
    expect(q.attempts.map((x) => [x.tier, x.outcome, x.risky])).toEqual([['opus', 'escalated', true], ['fable', 'escalated', true]]);
    expect(q.attempts.every((x) => typeof x.reason === 'string' && x.reason.length > 0)).toBe(true);

    const open = (await a.api<{ questions: Question[] }>('GET', '/api/questions')).body.questions;
    expect(open.map((x) => x.id)).toEqual([q.id]);
    expect((await a.api('GET', `/api/questions/${q.id}`)).body).toMatchObject({ id: q.id, tier: 'human', notifyCount: 1 });
    const waiting = await a.job(job.id);
    expect(waiting).toMatchObject({ status: 'waiting_answer', questionId: q.id, resumeOn: 'local' });
    expect(waiting.laneId).toBeUndefined();

    expect((await a.api('POST', `/api/questions/${q.id}/answer`, { answer: '' })).status).toBe(400);
    const res = await a.api<Question>('POST', `/api/questions/${q.id}/answer`, { answer: 'go ahead' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'go ahead' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'go ahead' });

    expect((await a.api('POST', `/api/questions/${q.id}/answer`, { answer: 'again' })).status).toBe(409);
    expect((await a.api('POST', '/api/questions/nope/answer', { answer: 'x' })).status).toBe(404);
    expect((await a.api('GET', '/api/questions/nope')).status).toBe(404);
    expect((await a.api('GET', '/api/questions?status=bogus')).status).toBe(400);
    expect((await a.api('GET', '/api/questions')).body.questions).toEqual([]);
    expect((await a.api('GET', '/api/questions?status=answered')).body.questions.map((x: Question) => x.id)).toEqual([q.id]);
  });

  it('a risk rule escalates a question the models were confident about', async () => {
    const a = await start();
    const job = await a.push(ask('Should I delete the old branch?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[0]!.riskRules).toEqual(['delete']);
  });

  it('re-notifies, then expires: question.expired, the job fails', async () => {
    const a = await start({ JOB_HOPPER_HUMAN_RENOTIFY_MS: '100', JOB_HOPPER_HUMAN_TIMEOUT_MS: '450' });
    const job = await a.push(ask('Is this risky?'));
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe('question unanswered');
    const events = ofJob(await a.events(), job.id);
    const human = events.filter((e) => e.type === 'question.escalated' && e.data.target === 'human');
    expect(human.length).toBeGreaterThanOrEqual(3);
    expect(human.slice(1).every((e) => e.data.renotify === true)).toBe(true);
    expect(human.map((e) => e.data.notifyCount)).toEqual(human.map((_, i) => i + 1));
    const expired = events.find((e) => e.type === 'question.expired');
    expect(expired).toBeDefined();
    expect(events.map((e) => e.type).indexOf('job.failed')).toBeGreaterThan(events.indexOf(expired!));
    expect((await a.questionsOf(job.id))[0]!.status).toBe('expired');
  });

  it('cancelling a waiting job cancels its question', async () => {
    const a = await start();
    const job = await a.push(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const res = await a.api<Job>('POST', `/api/jobs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect((await a.api('GET', `/api/questions/${q.id}`)).body.status).toBe('cancelled');
    expect((await a.api('POST', `/api/questions/${q.id}/answer`, { answer: 'x' })).status).toBe(409);
    const cancelled = ofJob(await a.events(), job.id).find((e) => e.type === 'job.cancelled');
    expect(cancelled!.data).toEqual({ reason: 'cancelled while waiting_answer' });
  });

  it('a waiting job frees its lane: another job runs on the only lane meanwhile', async () => {
    const a = await start({ JOB_HOPPER_LOCAL_LANES: '1' });
    const first = await a.push(ask('Is this risky?'));
    await a.waitForQuestion(first.id, (x) => x.tier === 'human');
    const second = await a.push({ executor: 'test', payload: { op: 'echo', message: 'meanwhile' } });
    await a.waitForStatus(second.id, 'finished');
    expect((await a.job(first.id)).status).toBe('waiting_answer');
    const queue = (await a.api('GET', '/api/queue')).body;
    expect(queue.waitingAnswer.map((j: Job) => j.id)).toEqual([first.id]);
    expect(queue.counts.waiting_answer).toBe(1);
    expect((await a.api('GET', '/api/jobs?status=waiting_answer')).body.jobs.map((j: Job) => j.id)).toEqual([first.id]);
  });

  it('delivers question.escalated with target human to a webhook subscriber', async () => {
    const a = await start();
    receiver = await startReceiver();
    await a.api('POST', '/api/webhooks', { url: receiver.url, events: ['question.escalated'] });
    const job = await a.push(ask('Is this risky?', { goal: 'tidy up' }));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const body = await waitFor(() => receiver!.received.map((r) => JSON.parse(r.body) as DomainEvent)
      .find((e) => e.data.target === 'human'));
    expect(body).toMatchObject({ type: 'question.escalated', jobId: job.id, questionId: q.id });
    expect(body.data).toEqual({
      questionId: q.id, target: 'human', reason: expect.any(String), text: 'Is this risky?', jobId: job.id,
      goal: 'tidy up', answerUrl: `${a.url}/#question-${q.id}`, notifyCount: 1,
    });
  });
});

describe('question budget', () => {
  it('fails a job that asks more than JOB_HOPPER_MAX_QUESTIONS, without a new question', async () => {
    const asker = createAskerExecutor();
    const a = await start({ JOB_HOPPER_MAX_QUESTIONS: '2' }, { executors: [asker] });
    const job = await a.push({ executor: 'asker', payload: {} });
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.error).toBe('too many questions');
    expect(await a.questionsOf(job.id)).toHaveLength(2);
    expect(asker.answers).toHaveLength(2);
    await waitFor(() => asker.cleaned.includes(job.id));
  });
});
