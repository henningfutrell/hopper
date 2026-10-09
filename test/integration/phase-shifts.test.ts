// Phase shifts from a question (issue #548) over the real HTTP server and database. A job's question can be answered
// with a phase shift: Research this or Propose this, with a note scoping the aspect, as a fork (a separate research or
// proposal job about that aspect; its accepted result answers the question) or a switch (the same job and session move
// into the research or proposal phase; accepted, the person picks whether the job goes back to work, ends, or — from
// research — goes on to a proposal). The scripted executor asks (`ask`), then follows what it is told; reviewer and
// escalation levels are doubles at the EscalationLevel seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionOutcome, Executor, EscalationLevel } from '../../src/domain/ports.ts';
import type { DomainEvent, Job, QuestionView, ReviewItemView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

type Section = 'research' | 'proposals';
// `hard`: the default fake escalation levels pass it to a person (test/support/fake-questions.ts).
const ask = (message = 'A hard one: which auth scheme should the API use?') => ({ op: 'ask', message });
const itemsOf = async (a: TestApp, section: Section, jobId: string): Promise<ReviewItemView[]> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', `/api/${section}?status=all`)).body.items.filter((p) => p.jobId === jobId);
const waitForItem = (a: TestApp, section: Section, jobId: string, ok: (p: ReviewItemView) => boolean = (p) => p.status === 'open' && p.stage === 'human') => waitFor(async () => {
  const p = (await itemsOf(a, section, jobId))[0];
  return p && ok(p) ? p : undefined;
}, { what: `a matching ${section} item on job ${jobId}` });
const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);
const openQuestion = async (a: TestApp, jobId: string): Promise<QuestionView> => {
  const q = await a.waitForQuestion(jobId, (x) => x.status === 'open' && x.tier === 'human');
  return (await a.api<QuestionView>('GET', `/api/questions/${q.id}`)).body;
};
const shift = (a: TestApp, token: string, questionId: string, to: 'research' | 'propose', body: Record<string, unknown>) =>
  a.ui<{ question: QuestionView; job: Job; fork?: Job }>(`/ui/api/questions/${questionId}/${to}`, body, { token });
const decide = (a: TestApp, token: string, section: Section, id: string, how: string, body: Record<string, unknown> = {}) =>
  a.ui<ReviewItemView>(`/ui/api/${section}/${id}/${how}`, body, { token });

describe('a question answered with Switch', () => {
  it('moves the same job into research; accepted, the person sends it back to work with the report as context', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask());
    const q = await openQuestion(a, job.id);
    // The question offers the shifts the server takes: both modes, the default first.
    expect(q.shifts).toEqual({ modes: ['fork', 'switch'], defaultMode: 'fork' });
    const r = await shift(a, token, q.id, 'research', { mode: 'switch', note: 'research only the auth part' });
    expect(r.status).toBe(200);
    expect(r.body.question).toMatchObject({ status: 'answered', answeredBy: 'human' });
    expect(r.body.job).toMatchObject({ phase: 'research', shift: { to: 'research', questionId: q.id, note: 'research only the auth part' } });
    const changed = ofJob(await a.events(), job.id).find((e) => e.type === 'job.phase_changed')!;
    expect(changed.questionId).toBe(q.id);
    expect(changed.data).toMatchObject({ from: 'work', to: 'research', mode: 'switch', reason: 'research only the auth part', questionId: q.id });
    // The same job, in its session, writes the research report.
    const item = await waitForItem(a, 'research', job.id);
    expect(item.versions[0]!.text).toContain('research only the auth part');
    expect(item).toMatchObject({ switchedFrom: { jobId: job.id, questionId: q.id }, then: ['work', 'end', 'proposal'] });
    expect(await a.job(job.id)).toMatchObject({ status: 'waiting_answer', researchId: item.id, phase: 'research' });
    expect((await decide(a, token, 'research', item.id, 'accept', { notes: 'use OAuth', then: 'work' })).body).toMatchObject({ status: 'accepted', signOff: { then: 'work' } });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.phase).toBe('work');
    expect(done.shift).toBeUndefined();
    const told = (done.result as { answer: string }).answer;
    expect(told).toContain('research report was accepted');
    expect(told).toContain('use OAuth');
    expect(told).toContain('HOPPER_DONE');
    const phases = ofJob(await a.events(), job.id).filter((e) => e.type === 'job.phase_changed').map((e) => [e.data.from, e.data.to]);
    expect(phases).toEqual([['work', 'research'], ['research', 'work']]);
  });

  it('accepted research may go on to a proposal in the same job, and an accepted proposal may end it', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask());
    const q = await openQuestion(a, job.id);
    expect((await shift(a, token, q.id, 'research', { mode: 'switch' })).status).toBe(200);
    const item = await waitForItem(a, 'research', job.id);
    expect((await decide(a, token, 'research', item.id, 'accept', { then: 'proposal' })).status).toBe(200);
    const p = await waitForItem(a, 'proposals', job.id);
    // Only a research phase goes on to a proposal.
    expect(p.then).toEqual(['work', 'end']);
    expect((await a.job(job.id)).phase).toBe('proposal');
    expect((await decide(a, token, 'proposals', p.id, 'accept', { then: 'proposal' })).status).toBe(409);
    expect((await decide(a, token, 'proposals', p.id, 'accept', { then: 'end' })).status).toBe(200);
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ research: { id: item.id, version: 1, decision: 'accept' }, proposal: { id: p.id, version: 1, decision: 'accept' } });
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'job.phase_changed').map((e) => [e.data.from, e.data.to]))
      .toEqual([['work', 'research'], ['research', 'proposal']]);
  });

  it('accepted switched research may end the job: it ends with its decision, not by going on', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask());
    const q = await openQuestion(a, job.id);
    expect((await shift(a, token, q.id, 'research', { mode: 'switch' })).status).toBe(200);
    const item = await waitForItem(a, 'research', job.id);
    expect((await decide(a, token, 'research', item.id, 'accept', { then: 'end' })).status).toBe(200);
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ research: { id: item.id, version: 1, decision: 'accept' } });
    expect(ofJob(await a.events(), job.id).filter((e) => e.type === 'job.requeued').map((e) => e.data.reason)).toEqual(['answered']);
  });

  it('a person picks only for a switched phase: a review item no question switched to takes no `then`', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull({ op: 'research', message: 'Findings: x' }, { labels: ['hopper:research'] });
    const item = await waitForItem(a, 'research', job.id);
    expect(item.then).toBeUndefined();
    expect((await decide(a, token, 'research', item.id, 'accept', { then: 'work' })).status).toBe(409);
  });
});

describe('a question answered with Fork', () => {
  it('spins off a research job about the aspect; the parent keeps waiting; the accepted report answers its question', async () => {
    const a = await start();
    const token = await a.login();
    const parent = await a.pull(ask(), { priority: 80, priorityReason: 'label:hopper:high', title: 'auth for the API' });
    const q = await openQuestion(a, parent.id);
    const r = await shift(a, token, q.id, 'research', { note: 'only the token lifetime' });
    expect(r.status).toBe(200);
    const fork = r.body.fork!;
    expect(fork).toMatchObject({
      status: 'queued', priority: 80, accepted: true, phase: 'research',
      forkOf: { jobId: parent.id, questionId: q.id, kind: 'research', note: 'only the token lifetime' },
    });
    expect(fork.source).toBeUndefined();
    // The parent waits on its question, and records its fork.
    expect(r.body.question.status).toBe('open');
    expect(await a.job(parent.id)).toMatchObject({ status: 'waiting_answer', questionId: q.id, forks: [fork.id] });
    expect(ofJob(await a.events(), parent.id).find((e) => e.type === 'job.forked')!.data)
      .toMatchObject({ forkId: fork.id, to: 'research', mode: 'fork', questionId: q.id, note: 'only the token lifetime', parent: 'waiting' });
    // The fork writes the report; Research shows where it came from.
    const item = await waitForItem(a, 'research', fork.id);
    expect(item).toMatchObject({ forkOf: { jobId: parent.id, questionId: q.id }, source: { title: 'auth for the API' }, priority: 80, high: true });
    expect(item.then).toBeUndefined();
    expect((await decide(a, token, 'research', item.id, 'accept', { notes: 'one hour' })).status).toBe(200);
    expect((await a.waitForStatus(fork.id, 'finished')).result).toEqual({ research: { id: item.id, version: 1, decision: 'accept' } });
    // Accepting the fork's result resolves the parent's question: the parent goes on with it as the answer.
    const answered = await a.waitForQuestion(parent.id, (x) => x.id === q.id && x.status === 'answered');
    expect(answered.answeredBy).toBe(`fork:${fork.id}`);
    expect(answered.answer).toContain('only the token lifetime');
    expect(answered.answer).toContain('one hour');
    const done = await a.waitForStatus(parent.id, 'finished');
    expect((done.result as { answer: string }).answer).toContain('research report');
    expect(ofJob(await a.events(), parent.id).find((e) => e.type === 'job.fork_resolved')!.data)
      .toMatchObject({ forkId: fork.id, decision: 'accept', delivered: true });
  });

  it('a rejected forked proposal leaves the parent\'s question open', async () => {
    const a = await start();
    const token = await a.login();
    const parent = await a.pull(ask());
    const q = await openQuestion(a, parent.id);
    const fork = (await shift(a, token, q.id, 'propose', { mode: 'fork', note: 'options for the schema' })).body.fork!;
    expect(fork.spec.proposal).toBe(true);
    const p = await waitForItem(a, 'proposals', fork.id);
    expect((await decide(a, token, 'proposals', p.id, 'reject', { notes: 'not now' })).status).toBe(200);
    await a.waitForStatus(fork.id, 'finished');
    await waitFor(async () => ofJob(await a.events(), parent.id).find((e) => e.type === 'job.fork_resolved'), { what: 'job.fork_resolved' });
    expect((await a.questionsOf(parent.id)).find((x) => x.id === q.id)!.status).toBe('open');
    expect((await a.job(parent.id)).status).toBe('waiting_answer');
  });
});

describe('phase-shift settings and refusals', () => {
  const plain: Executor = {
    name: 'plain', validate: () => null,
    run: async (): Promise<ExecutionOutcome> => ({ kind: 'question', question: { text: 'A hard one: which one?', recentOutput: '', detectedBy: 'test' } }),
    resume: async (_ctx, answer): Promise<ExecutionOutcome> => ({ kind: 'finished', result: { answer } }),
  };

  it('the settings live in the database and apply at once: the default mode, the parent under a fork, the levels that may shift', async () => {
    const level = createFakeLevel({ name: 'low', script: () => ({ escalate: true, reason: 'no' }) });
    const a = await start({ seams: { levels: [level] } });
    const token = await a.login();
    expect((await a.api('GET', '/api/phase-shifts')).body).toEqual({ defaultMode: 'fork', forkParent: 'wait', levels: [], choices: { levels: ['low'] } });
    expect((await a.ui('/ui/api/phase-shifts', { levels: ['nobody'] }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/phase-shifts', {}, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/phase-shifts', { defaultMode: 'switch', levels: ['low'] }, { token })).body).toMatchObject({ defaultMode: 'switch', forkParent: 'wait', levels: ['low'] });
    expect((await a.events()).some((e) => e.type === 'phase_shifts.settings_changed')).toBe(true);
    const job = await a.pull(ask());
    const q = await openQuestion(a, job.id);
    expect(q.shifts).toEqual({ modes: ['fork', 'switch'], defaultMode: 'switch' });
    // No mode named: the default.
    expect((await shift(a, token, q.id, 'research', {})).body.job).toMatchObject({ phase: 'research' });
  });

  it('a job whose executor cannot write a research report or a proposal is offered no shift, and the server refuses one', async () => {
    const a = await start({ seams: { executors: [plain] } });
    const token = await a.login();
    const job = await a.pull({}, { executor: 'plain' });
    const q = await openQuestion(a, job.id);
    expect(q.shifts).toEqual({ modes: [], defaultMode: 'fork', refusal: 'its executor plain cannot write a research report or a proposal' });
    expect((await shift(a, token, q.id, 'research', { mode: 'fork' })).status).toBe(409);
    expect((await shift(a, token, q.id, 'research', { mode: 'switch' })).status).toBe(409);
    expect((await a.api<{ reviewingExecutors: string[] }>('GET', '/api/health')).body.reviewingExecutors).toContain('scripted');
  });

  it('a question no longer open takes no shift; an unknown mode is a bad request', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(ask());
    const q = await openQuestion(a, job.id);
    expect((await shift(a, token, q.id, 'research', { mode: 'sideways' })).status).toBe(400);
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'OAuth' }, { token })).status).toBe(200);
    expect((await shift(a, token, q.id, 'research', { mode: 'fork' })).status).toBe(409);
    expect((await shift(a, token, 'nope', 'research', { mode: 'fork' })).status).toBe(404);
  });
});

describe('a suggested phase shift', () => {
  it('a job suggests research on its question; the card offers it, and only a person shifts', async () => {
    const a = await start();
    const job = await a.pull(ask('A hard one: which cache should we use?\nSuggest: research — the cache eviction options'));
    const q = await openQuestion(a, job.id);
    expect(q.suggestion).toEqual({ to: 'research', note: 'the cache eviction options', by: 'job' });
    expect((await a.job(job.id)).phase).toBe('work');
  });

  it('an escalation level suggests; only a level the settings allow shifts the phase itself, in the default mode', async () => {
    const levels: EscalationLevel[] = [
      createFakeLevel({ name: 'low', script: () => ({ escalate: true, reason: 'needs research', suggest: { to: 'research', note: 'the retry policy' } }) }),
      createFakeLevel({ name: 'high', script: () => ({ escalate: true, reason: 'still needs research', suggest: { to: 'proposal', note: 'the retry design' } }) }),
    ];
    const a = await start({ seams: { levels } });
    const token = await a.login();
    // Not allowed: the suggestion is shown, the question climbs to a person.
    const first = await a.pull(ask());
    const q = await openQuestion(a, first.id);
    expect(q.suggestion).toEqual({ to: 'research', note: 'the retry policy', by: 'low' });
    expect(q.attempts.map((x) => x.suggest)).toEqual([{ to: 'research', note: 'the retry policy' }, { to: 'proposal', note: 'the retry design' }]);
    // Allowed: the level shifts itself, a fork in the default mode; the question stays open for the fork's answer.
    expect((await a.ui('/ui/api/phase-shifts', { levels: ['low'] }, { token })).status).toBe(200);
    const second = await a.pull(ask());
    const forked = await waitFor(async () => (await a.job(second.id)).forks?.[0], { what: 'a fork of the second job' });
    const shifted = ofJob(await a.events(), second.id).find((e) => e.type === 'job.forked')!;
    expect(shifted.data).toMatchObject({ forkId: forked, to: 'research', by: 'low', note: 'the retry policy' });
    expect((await a.job(forked)).forkOf).toMatchObject({ jobId: second.id, kind: 'research' });
  });
});
