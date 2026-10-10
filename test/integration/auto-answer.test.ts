// Auto-answer over the real HTTP server and database (issue #632): a question the frontier level answers without
// escalating, sure enough, goes into the job with no person; a risky one still reaches a person; the settings and the
// agreement stats are at GET /api/question-gates and POST /ui/api/auto-answer; a person corrects an auto-answer through
// POST /ui/api/questions/:id/correct, and the job gets the correction ahead of its next answer.
import { afterEach, describe, expect, it } from 'vitest';
import type { LevelReply } from '../../src/domain/ports.ts';
import type { AutoAnswerView, QuestionGatesView, QuestionView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createAskerExecutor } from '../support/doubles.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** One level, `frontier`: answers question 1 sure of it, sends any later one up as a recommendation. */
const frontier = createFakeLevel({
  name: 'frontier',
  script: (req): LevelReply => (/number 1\?/.test(req.question.text) || /colour/i.test(req.question.text)
    ? { answer: 'Blue.', escalate: false, reason: 'the job settles it', confidence: 'high' }
    : { answer: 'Red.', escalate: true, reason: 'the owner\'s call', confidence: 'medium' }),
});

async function start(seams: Parameters<typeof startTestApp>[0]['seams'] = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, seams: { levels: [frontier], ...seams } });
  return t;
}

describe('auto-answer', () => {
  it('the frontier level answers sure of it: the job gets the answer with no person, and the stats count it', async () => {
    const a = await start();
    const job = await a.pull({ op: 'ask', message: 'Which colour?' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'Blue.' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'frontier', answer: 'Blue.' });
    expect(q!.attempts).toEqual([expect.objectContaining({ tier: 'frontier', confidence: 'high', outcome: 'accepted' })]);
    expect((await a.events('types=question.escalated_to_human')).filter((e) => e.jobId === job.id)).toHaveLength(0);
    const gates = (await a.api('GET', '/api/question-gates')).body as QuestionGatesView;
    expect(gates.autoAnswer).toEqual({ enabled: true, threshold: 'high', stats: { windowDays: 30, answered: 1, corrected: 0, agreement: 1 } });
  });

  it('a risky question reaches a person, whatever the level says', async () => {
    const a = await start();
    const job = await a.pull({ op: 'ask', message: 'Which colour, and may I delete the old branch?' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[0]).toMatchObject({ riskRules: ['delete'], outcome: 'escalated' });
    expect((await a.job(job.id)).status).toBe('waiting_answer');
  });

  it('an admin turns auto-answer off: the sure answer waits for a person; the change is an event', async () => {
    const a = await start();
    const token = await a.login();
    const r = await a.ui<AutoAnswerView>('/ui/api/auto-answer', { enabled: false }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, threshold: 'high' });
    expect((await a.events('types=auto_answer.settings_changed'))[0]!.data).toMatchObject({ from: { enabled: true }, to: { enabled: false } });
    expect((await a.ui('/ui/api/auto-answer', { threshold: 'certain' }, { token })).status).toBe(400);
    const job = await a.pull({ op: 'ask', message: 'Which colour?' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q.attempts[0]).toMatchObject({ answer: 'Blue.', outcome: 'escalated' });
  });

  it('a person corrects an auto-answer: the question keeps what it replaced, and the job gets the correction with its next answer', async () => {
    const asker = createAskerExecutor();
    const a = await start({ executors: [asker] });
    const token = await a.login();
    const job = await a.pull({}, { executor: 'asker' });
    // Question 1 is auto-answered; question 2 waits for a person.
    const second = await a.waitForQuestion(job.id, (x) => x.text === 'Question number 2?' && x.tier === 'human');
    const [first] = (await a.questionsOf(job.id)).filter((x) => x.text === 'Question number 1?');
    expect(asker.answers).toEqual(['Blue.']);

    const r = await a.ui<QuestionView>(`/ui/api/questions/${first!.id}/correct`, { answer: 'Green.' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answer: 'Green.', answeredBy: 'human', corrected: { level: 'frontier', was: 'Blue.' } });
    expect((await a.job(job.id)).pendingCorrection).toMatch(/Green\./);
    expect((await a.ui(`/ui/api/questions/${first!.id}/correct`, { answer: 'Again.' }, { token })).status).toBe(409);
    expect((await a.ui(`/ui/api/questions/${second.id}/correct`, { answer: 'x' }, { token })).status).toBe(409);

    await a.ui(`/ui/api/questions/${second.id}/answer`, { answer: 'Red is fine.' }, { token });
    await waitFor(() => asker.answers.length === 2, { what: 'the second answer typed in' });
    expect(asker.answers[1]).toMatch(/^A person corrected an answer you got earlier\.[\s\S]*Question number 1\?[\s\S]*Blue\.[\s\S]*Green\.\n\nRed is fine\.$/);
    expect((await a.job(job.id)).pendingCorrection).toBeUndefined();
    const gates = (await a.api('GET', '/api/question-gates')).body as QuestionGatesView;
    expect(gates.autoAnswer.stats).toMatchObject({ answered: 1, corrected: 1, agreement: 0 });
  });
});
