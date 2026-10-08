// Questions over the real HTTP server and database: the scripted executor's `ask` op and the
// fake escalation levels (policy in test/support/fake-questions.ts: level `opus` answers unless the
// question says "unsure", "risky" or "hard"; level `fable` answers unless it says "risky" or
// "hard"; the risk rules apply on top), or scripted doubles at the EscalationLevel seam. Human
// answers and cancels go through the UI session routes.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { CLOSED_ANSWER, createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createAskerExecutor } from '../support/doubles.ts';
import { writeWebhooks } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let receiver: Receiver | undefined;

async function start(env: Record<string, string> = {}, o: Omit<Parameters<typeof startTestApp>[0], 'dbPath' | 'env'> & { before?: (dbPath: string) => void } = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  o.before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, env, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  await receiver?.close();
  receiver = undefined;
  cleanup?.();
});

const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const ask = (message: string) => ({ op: 'ask', message });

describe('a question a level answers', () => {
  it('opus answers; the job resumes with its answer and finishes; fable is never asked', async () => {
    const a = await start();
    const job = await a.pull(ask('Which colour?'), { title: 'paint the shed' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: 'fake opus answer' });
    expect(done.pendingAnswer).toBeUndefined();
    expect(done.attempts).toBe(2);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus', answer: 'fake opus answer', text: 'Which colour?', detectedBy: 'test' });
    expect(q!.attempts).toEqual([
      expect.objectContaining({ tier: 'opus', role: 'level', model: 'fake-opus', outcome: 'accepted', escalate: false }),
    ]);
    const events = ofJob(await a.events(), job.id);
    const types = events.map((e) => e.type);
    expect(types.indexOf('question.asked')).toBeLessThan(types.indexOf('question.answered'));
    expect(types.indexOf('question.answered')).toBeLessThan(types.indexOf('job.requeued'));
    expect(types.filter((x) => x === 'job.started')).toHaveLength(2);
    expect(types.at(-1)).toBe('job.finished');
    expect(events.find((e) => e.type === 'question.asked')!.data).toEqual({ questionId: q!.id, text: 'Which colour?', detectedBy: 'test' });
    expect(events.find((e) => e.type === 'question.answered')).toMatchObject({ schemaVersion: 2, data: { by: 'opus', answer: 'fake opus answer' } });
    expect(events.find((e) => e.type === 'job.requeued')!.data).toEqual({ from: 'waiting_answer', reason: 'answered' });
    expect(events.filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['opus']);
    await waitFor(() => a.source.reports.some((r) => r.kind === 'finished' && r.job.id === job.id), { what: 'finished report' });
    expect(a.source.reports.filter((r) => r.job.id === job.id).map((r) => r.kind)).toEqual(['claimed', 'finished']);
  });

  it('opus escalates what it is unsure of; fable answers it', async () => {
    const a = await start();
    const job = await a.pull(ask('I am unsure: which colour?'));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'fake fable answer' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ answeredBy: 'fable', tier: 'fable' });
    expect(q!.attempts.map((x) => [x.tier, x.outcome, x.answer])).toEqual([['opus', 'escalated', 'fake opus answer'], ['fable', 'accepted', 'fake fable answer']]);
  });

  it('fail-after-answer fails the job on resume and clears the pending answer', async () => {
    const a = await start();
    const job = await a.pull({ op: 'fail-after-answer', message: 'Go?' });
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.pendingAnswer).toBeUndefined();
  });
});

describe('the pipeline end to end through the seams', () => {
  it('scripted levels answer a pulled job\'s question; the level above sees the recommendation below', async () => {
    const seen: string[] = [];
    const low = createFakeLevel({ name: 'low', script: (req) => ({ answer: `draft for ${req.question.text}`, escalate: true, reason: 'not sure' }) });
    const high = createFakeLevel({ name: 'high', script: (req) => { seen.push(req.previous.map((x) => x.answer).join()); return { answer: 'spaces', escalate: false, reason: 'fine' }; } });
    const a = await start({}, { seams: { levels: [low, high] } });
    const job = await a.pull(ask('Tabs or spaces?'));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'spaces' });
    expect(seen).toEqual(['draft for Tabs or spaces?']);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ answeredBy: 'high', tier: 'high' });
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['low', 'high']);
  });

  it('a level returning garbage escalates; past the top level the question reaches the human', async () => {
    const level = createFakeLevel({ name: 'judge', script: () => ({ escalate: 'false' }) as never });
    const a = await start({}, { seams: { levels: [level] } });
    const job = await a.pull(ask('Pick a name. Do not escalate'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts.map((x) => [x.tier, x.outcome])).toEqual([['judge', 'escalated']]);
    expect((await a.job(job.id)).status).toBe('waiting_answer');
  });

  it('no levels: the question is created at the human stage and reaches the human', async () => {
    const a = await start({}, { seams: { levels: [] } });
    const job = await a.pull(ask('Which colour?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human' && x.notifyCount === 1);
    expect(q.attempts).toEqual([]);
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['human']);
  });
});

describe('the order of the question lists (issue #450)', () => {
  it('open questions come oldest first, the longest waiting on top; every other listing newest first', async () => {
    const a = await start({}, { seams: { levels: [] } });
    const first = await a.pull(ask('Which colour?'));
    const q1 = await a.waitForQuestion(first.id, (x) => x.tier === 'human');
    const second = await a.pull(ask('Which size?'));
    const q2 = await a.waitForQuestion(second.id, (x) => x.tier === 'human');
    const ids = async (path: string) => (await a.api<{ questions: Question[] }>('GET', path)).body.questions.map((x) => x.id);
    expect(await ids('/api/questions')).toEqual([q1.id, q2.id]);
    expect(await ids('/api/questions?status=open')).toEqual([q1.id, q2.id]);
    expect(await ids('/api/questions?status=all')).toEqual([q2.id, q1.id]);
  });
});

describe('a question escalated to the human', () => {
  it('every level escalates; nothing goes to the source, and a UI answer resumes the job', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts.map((x) => [x.tier, x.outcome, x.escalate])).toEqual([['opus', 'escalated', true], ['fable', 'escalated', true]]);
    expect((await a.api<{ questions: Question[] }>('GET', '/api/questions')).body.questions.map((x) => x.id)).toEqual([q.id]);
    const waiting = await a.job(job.id);
    expect(waiting).toMatchObject({ status: 'waiting_answer', questionId: q.id, resumeOn: 'local' });
    await a.sync();
    expect(a.source.reports.filter((r) => r.job.id === job.id).map((r) => r.kind)).toEqual(['claimed']);

    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: '' }, { token })).status).toBe(400);
    const res = await a.ui<Question>(`/ui/api/questions/${q.id}/answer`, { answer: 'go ahead' }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'go ahead' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'go ahead' });
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'again' }, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/questions/nope/answer', { answer: 'x' }, { token })).status).toBe(404);
    expect((await a.api('GET', '/api/questions/nope')).status).toBe(404);
    expect((await a.api('GET', '/api/questions?status=bogus')).status).toBe(400);
  });

  // Issue #459: Use answer sends at once, and a retry must not answer twice. The answer is idempotent per
  // question: the same answer again is the question as it is, with no second effect; another answer is 409.
  it('the same UI answer sent twice is one answer: one question.answered, one resume; another answer is 409', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const path = `/ui/api/questions/${q.id}/answer`;
    const [one, two] = await Promise.all([a.ui<Question>(path, { answer: 'take option 1' }, { token }), a.ui<Question>(path, { answer: 'take option 1' }, { token })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(two.body).toMatchObject({ id: q.id, status: 'answered', answeredBy: 'human', answer: 'take option 1' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'take option 1' });
    expect((await a.ui<Question>(path, { answer: 'take option 1' }, { token })).status).toBe(200);
    expect((await a.ui(path, { answer: 'take option 2' }, { token })).status).toBe(409);
    const events = ofJob(await a.events(), job.id);
    expect(events.filter((e) => e.type === 'question.answered')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'job.requeued')).toHaveLength(1);
    const stored = (await a.api<Question>('GET', `/api/questions/${q.id}`)).body;
    expect(stored.attempts.filter((x) => x.tier === 'human')).toHaveLength(1);
  });

  it('a risk rule sends a question a level answered to the human, past the levels above', async () => {
    const a = await start();
    const job = await a.pull(ask('Should I delete the old branch?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts).toEqual([expect.objectContaining({ tier: 'opus', escalate: false, riskRules: ['delete'], outcome: 'escalated' })]);
  });

  it('re-notifies, then expires: question.expired, the job fails', async () => {
    const a = await start({ HOPPER_HUMAN_RENOTIFY_MS: '100', HOPPER_HUMAN_TIMEOUT_MS: '450' });
    const job = await a.pull(ask('Is this risky?'));
    expect((await a.waitForStatus(job.id, 'failed')).error).toBe('question unanswered');
    const events = ofJob(await a.events(), job.id);
    const human = events.filter((e) => e.type === 'question.escalated' && e.data.target === 'human');
    expect(human.length).toBeGreaterThanOrEqual(3);
    expect(human.slice(1).every((e) => e.data.renotify === true)).toBe(true);
    expect(events.find((e) => e.type === 'question.expired')).toBeDefined();
    await waitFor(() => a.source.reports.some((r) => r.kind === 'failed' && r.job.id === job.id));
    expect(a.source.reports.filter((r) => r.job.id === job.id).map((r) => r.kind)).toEqual(['claimed', 'failed']);
  });

  it('Close in the UI ends the question: question.closed, and the job resumes with the fixed close text and finishes', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const res = await a.ui<Question>(`/ui/api/questions/${q.id}/close`, {}, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'closed', answeredBy: 'human', answer: CLOSED_ANSWER });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: CLOSED_ANSWER });
    const events = ofJob(await a.events(), job.id);
    expect(events.find((e) => e.type === 'question.closed')).toMatchObject({ questionId: q.id, data: { questionId: q.id, answer: CLOSED_ANSWER } });
    expect(events.find((e) => e.type === 'question.answered')).toBeUndefined();
    expect(events.find((e) => e.type === 'job.requeued')!.data).toEqual({ from: 'waiting_answer', reason: 'closed' });
    expect((await a.api<{ questions: Question[] }>('GET', '/api/questions')).body.questions).toEqual([]);
    expect((await a.api<{ questions: Question[] }>('GET', '/api/questions?status=closed')).body.questions.map((x) => x.id)).toEqual([q.id]);
    expect((await a.ui(`/ui/api/questions/${q.id}/close`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/questions/nope/close', {}, { token })).status).toBe(404);
  });

  it('Close is guarded like answer: no session, no close', async () => {
    const a = await start();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect((await a.ui(`/ui/api/questions/${q.id}/close`, {})).status).toBe(403);
    expect((await a.api('GET', `/api/questions/${q.id}`)).body.status).toBe('open');
  });

  it('Dismiss in the UI drops a question: question.dismissed, nothing typed in, and the job still waiting on it is cancelled', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const res = await a.ui<Question>(`/ui/api/questions/${q.id}/dismiss`, {}, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'dismissed' });
    expect(res.body.answer).toBeUndefined();
    const done = await a.waitForStatus(job.id, 'cancelled');
    expect(done.pendingAnswer).toBeUndefined();
    const events = ofJob(await a.events(), job.id);
    expect(events.find((e) => e.type === 'question.dismissed')).toMatchObject({ questionId: q.id, data: { questionId: q.id } });
    expect(events.find((e) => e.type === 'job.cancelled')!.data).toEqual({ reason: 'question dismissed' });
    expect(events.find((e) => e.type === 'job.requeued')).toBeUndefined();
    expect((await a.api<{ questions: Question[] }>('GET', '/api/questions')).body.questions).toEqual([]);
    expect((await a.api<{ questions: Question[] }>('GET', '/api/questions?status=dismissed')).body.questions.map((x) => x.id)).toEqual([q.id]);
    expect((await a.ui(`/ui/api/questions/${q.id}/dismiss`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/questions/nope/dismiss', {}, { token })).status).toBe(404);
  });

  it('Dismiss and Seen are guarded like answer: no session, no change', async () => {
    const a = await start();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect((await a.ui(`/ui/api/questions/${q.id}/dismiss`, {})).status).toBe(403);
    expect((await a.ui(`/ui/api/questions/${q.id}/seen`, {})).status).toBe(403);
    const now = (await a.api<Question>('GET', `/api/questions/${q.id}`)).body;
    expect(now.status).toBe('open');
    expect(now.seenAt).toBeUndefined();
  });

  it('Seen marks a question seen once: seenAt is set, kept on a second call, and survives in the history', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.seenAt).toBeUndefined();
    const first = await a.ui<Question>(`/ui/api/questions/${q.id}/seen`, {}, { token });
    expect(first.status).toBe(200);
    expect(first.body.seenAt).toEqual(expect.any(String));
    const again = await a.ui<Question>(`/ui/api/questions/${q.id}/seen`, {}, { token });
    expect(again.body.seenAt).toBe(first.body.seenAt);
    expect((await a.api<Question>('GET', `/api/questions/${q.id}`)).body).toMatchObject({ status: 'open', seenAt: first.body.seenAt });
    expect((await a.ui('/ui/api/questions/nope/seen', {}, { token })).status).toBe(404);
    await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'go ahead' }, { token });
    const all = (await a.api<{ questions: Question[] }>('GET', '/api/questions?status=all')).body.questions;
    expect(all.find((x) => x.id === q.id)).toMatchObject({ status: 'answered', answer: 'go ahead', seenAt: first.body.seenAt });
  });

  it('cancelling a waiting job in the UI cancels its question', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const res = await a.ui<Job>(`/ui/api/jobs/${job.id}/cancel`, {}, { token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect((await a.api('GET', `/api/questions/${q.id}`)).body.status).toBe('cancelled');
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/jobs/missing/cancel', {}, { token })).status).toBe(404);
    const cancelled = ofJob(await a.events(), job.id).find((e) => e.type === 'job.cancelled');
    expect(cancelled!.data).toEqual({ reason: 'cancelled in UI' });
  });

  it('a waiting job frees its lane: another job runs on the only lane meanwhile', async () => {
    const a = await start({}, { plugins: { machines: lanes(1) } });
    const first = await a.pull(ask('Is this risky?'));
    await a.waitForQuestion(first.id, (x) => x.tier === 'human');
    const second = await a.pull({ op: 'echo', message: 'meanwhile' });
    await a.waitForStatus(second.id, 'finished');
    const queue = (await a.api('GET', '/api/queue')).body;
    expect(queue.waitingAnswer.map((j: Job) => j.id)).toEqual([first.id]);
  });

  it('delivers question.escalated with target human to a webhook subscription', async () => {
    receiver = await startReceiver();
    const url = receiver.url;
    const a = await start({}, { secrets: { WEBHOOK_SECRET_R: 's' }, before: (db) => writeWebhooks(db, [{ name: 'r', url, events: ['question.escalated'], secretEnv: 'WEBHOOK_SECRET_R' }]) });
    const job = await a.pull(ask('Is this risky?'), { title: 'tidy up' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const body = await waitFor(() => receiver!.received.map((r) => JSON.parse(r.body) as DomainEvent).find((e) => e.data.target === 'human'));
    expect(body).toMatchObject({ type: 'question.escalated', jobId: job.id, questionId: q.id, schemaVersion: 2 });
    expect(body.data).toEqual({
      questionId: q.id, target: 'human', reason: expect.any(String), text: 'Is this risky?', jobId: job.id,
      goal: 'tidy up', answerUrl: `${a.url}/#question-${q.id}`, notifyCount: 1,
    });
  });

  it('delivers question.escalated_to_human once to a webhook subscribed to it by name, and no level hop', async () => {
    receiver = await startReceiver();
    const url = receiver.url;
    const a = await start({}, { secrets: { WEBHOOK_SECRET_R: 's' }, before: (db) => writeWebhooks(db, [{ name: 'r', url, events: ['question.escalated_to_human'], secretEnv: 'WEBHOOK_SECRET_R' }]) });
    const job = await a.pull(ask('Is this risky?'), { title: 'tidy up' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const got = await waitFor(() => receiver!.received[0], { what: 'delivery' });
    expect(got.headers['x-hopper-event']).toBe('question.escalated_to_human');
    const body = JSON.parse(got.body) as DomainEvent;
    expect(body).toMatchObject({ type: 'question.escalated_to_human', jobId: job.id, questionId: q.id, schemaVersion: 1 });
    expect(body.data).toEqual({
      questionId: q.id, reason: expect.any(String), text: 'Is this risky?', jobId: job.id,
      goal: 'tidy up', answerUrl: `${a.url}/#question-${q.id}`, notifyCount: 1,
    });
    const events = ofJob(await a.events(), job.id);
    expect(events.filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['opus', 'fable', 'human']);
    expect(events.filter((e) => e.type === 'question.escalated_to_human')).toHaveLength(1);
    expect(receiver.received.map((r) => r.headers['x-hopper-event'])).toEqual(['question.escalated_to_human']);
  });
});

describe('question budget', () => {
  it('fails a job that asks more than HOPPER_MAX_QUESTIONS, without a new question', async () => {
    const asker = createAskerExecutor();
    const a = await start({ HOPPER_MAX_QUESTIONS: '2' }, { seams: { executors: [asker] } });
    const job = await a.pull({}, { executor: 'asker' });
    expect((await a.waitForStatus(job.id, 'failed')).error).toBe('too many questions');
    expect(await a.questionsOf(job.id)).toHaveLength(2);
    await waitFor(() => asker.cleaned.includes(job.id));
  });
});
