// Issue #459: the owner's answer is idempotent per question, over the real HTTP server and database. Use answer
// sends at once, so a second click or a retry must not answer twice: the same answer again is the question as
// it is, with no second attempt, event or resume; another answer is 409.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Question } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ofJob = (events: DomainEvent[], jobId: string) => events.filter((e) => e.jobId === jobId);

describe('the owner answers a question', () => {
  it('the same UI answer sent twice is one answer: one question.answered, one resume; another answer is 409', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = t = await startTestApp({ dbPath: db.dbPath, env: {} });
    const token = await a.login();
    const job = await a.pull({ op: 'ask', message: 'Is this risky?' });
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
});
