// Questions over the real HTTP server and SQLite file: the scripted executor's `ask` op and the
// fake question doubles (policy in test/support/fake-questions.ts: the answerer `opus`
// is confident unless the question says "unsure"; the assessor `fable` escalates when it says
// "risky" or "hard"; the risk rules apply on top), or scripted doubles at the Answerer / Assessor
// seams. Human answers and cancels go through the UI session routes.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { CLOSED_ANSWER, createFakeAnswerer, createFakeAssessor } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createAskerExecutor } from '../support/doubles.ts';
import { writeWebhooksFile } from '../support/files.ts';
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

describe('a question the assessor lets through', () => {
  it('opus drafts, fable does not escalate; the job resumes with the draft and finishes', async () => {
    const a = await start();
    const job = await a.pull(ask('Which colour?'), { title: 'paint the shed' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: 'fake opus answer' });
    expect(done.pendingAnswer).toBeUndefined();
    expect(done.attempts).toBe(2);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus', answer: 'fake opus answer', text: 'Which colour?', detectedBy: 'test' });
    expect(q!.attempts).toEqual([
      expect.objectContaining({ tier: 'opus', role: 'answerer', model: 'fake-opus', outcome: 'drafted', confident: true }),
      expect.objectContaining({ tier: 'fable', role: 'assessor', model: 'fake-fable', outcome: 'accepted', escalate: false }),
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
    expect(events.filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['opus', 'fable']);
    await waitFor(() => a.source.reports.some((r) => r.kind === 'finished' && r.job.id === job.id), { what: 'finished report' });
    expect(a.source.reports.filter((r) => r.job.id === job.id).map((r) => r.kind)).toEqual(['claimed', 'finished']);
  });

  it('fail-after-answer fails the job on resume and clears the pending answer', async () => {
    const a = await start();
    const job = await a.pull({ op: 'fail-after-answer', message: 'Go?' });
    const failed = await a.waitForStatus(job.id, 'failed');
    expect(failed.pendingAnswer).toBeUndefined();
  });
});

describe('the pipeline end to end through the seams', () => {
  const drafter = createFakeAnswerer({ name: 'drafter', script: (req) => ({ answer: `draft for ${req.question.text}`, confident: true, reason: 'obvious' }) });

  it('a scripted answerer and assessor answer a pulled job\'s question; the job finishes with the draft', async () => {
    const seen: string[] = [];
    const judge = createFakeAssessor({ name: 'judge', script: (req, draft) => { seen.push(`${req.question.text} | ${draft.answer}`); return { escalate: false, reason: 'fine' }; } });
    const a = await start({}, { seams: { answerer: drafter, assessor: judge } });
    const job = await a.pull(ask('Tabs or spaces?'));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'draft for Tabs or spaces?' });
    expect(seen).toEqual(['Tabs or spaces? | draft for Tabs or spaces?']);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ answeredBy: 'drafter', tier: 'judge' });
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['drafter', 'judge']);
  });

  it('an assessor returning garbage sends the question to the human', async () => {
    const judge = createFakeAssessor({ name: 'judge', script: () => ({ escalate: 'false' }) as never });
    const a = await start({}, { seams: { answerer: drafter, assessor: judge } });
    const job = await a.pull(ask('Pick a name. assessor: do not escalate'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts.map((x) => [x.tier, x.outcome])).toEqual([['drafter', 'drafted'], ['judge', 'escalated']]);
    expect((await a.job(job.id)).status).toBe('waiting_answer');
  });

  it('no answerer: the question is created at the human stage and reaches the human', async () => {
    const a = await start({}, { seams: { answerer: null } });
    const job = await a.pull(ask('Which colour?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human' && x.notifyCount === 1);
    expect(q.attempts).toEqual([]);
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'question.escalated').map((e) => e.data.target)).toEqual(['human']);
  });
});

describe('a question escalated to the human', () => {
  it('the assessor escalates; nothing goes to the source, and a UI answer resumes the job', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask('Is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts.map((x) => [x.tier, x.outcome, x.escalate])).toEqual([['opus', 'drafted', undefined], ['fable', 'escalated', true]]);
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

  it('an answerer that is not confident: the assessor still runs (Opus, then Fable, then the owner)', async () => {
    const a = await start();
    const job = await a.pull(ask('I am unsure, is this risky?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts.map((x) => [x.tier, x.outcome])).toEqual([['opus', 'drafted'], ['fable', 'escalated']]);
  });

  it('a risk rule escalates a question the assessor let through', async () => {
    const a = await start();
    const job = await a.pull(ask('Should I delete the old branch?'));
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[1]).toMatchObject({ tier: 'fable', escalate: false, riskRules: ['delete'], outcome: 'escalated' });
  });

  it('re-notifies, then expires: question.expired, the job fails', async () => {
    const a = await start({ JOB_HOPPER_HUMAN_RENOTIFY_MS: '100', JOB_HOPPER_HUMAN_TIMEOUT_MS: '450' });
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

  it('delivers question.escalated with target human to a webhook from webhooks.yaml', async () => {
    receiver = await startReceiver();
    const url = receiver.url;
    const a = await start({}, { before: (db) => writeWebhooksFile(db, [{ name: 'r', url, events: ['question.escalated'], secret: 's' }]) });
    const job = await a.pull(ask('Is this risky?'), { title: 'tidy up' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const body = await waitFor(() => receiver!.received.map((r) => JSON.parse(r.body) as DomainEvent).find((e) => e.data.target === 'human'));
    expect(body).toMatchObject({ type: 'question.escalated', jobId: job.id, questionId: q.id, schemaVersion: 2 });
    expect(body.data).toEqual({
      questionId: q.id, target: 'human', reason: expect.any(String), text: 'Is this risky?', jobId: job.id,
      goal: 'tidy up', answerUrl: `${a.url}/#question-${q.id}`, notifyCount: 1,
    });
  });
});

describe('question budget', () => {
  it('fails a job that asks more than JOB_HOPPER_MAX_QUESTIONS, without a new question', async () => {
    const asker = createAskerExecutor();
    const a = await start({ JOB_HOPPER_MAX_QUESTIONS: '2' }, { seams: { executors: [asker] } });
    const job = await a.pull({}, { executor: 'asker' });
    expect((await a.waitForStatus(job.id, 'failed')).error).toBe('too many questions');
    expect(await a.questionsOf(job.id)).toHaveLength(2);
    await waitFor(() => asker.cleaned.includes(job.id));
  });
});
