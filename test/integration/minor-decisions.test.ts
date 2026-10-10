// Decider calls through Jev first (issue #550), end to end: the real daemon and database, Jev as a double at its
// seam (`seams.jev`), escalation levels as doubles. A question that lists its options and a failure no rule explains
// ask Jev first. In shadow (the default) Jev's pick is recorded and compared with what was decided after it; active,
// a confident pick that nothing makes consequential is applied, and anything else goes on as before. Every pick is an
// event on its job; a person overrides one; the agreement rates show per decision point. Without Jev nothing is asked.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, JevChooser, JevPick, MinorDecisionAsk, MinorDecisionsView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** Jev as a double: picks what `answer` says, records every ask. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => { asks.push(ask); return answer(ask); },
  };
}

/** A level that answers every question with `answer`, and counts its calls. */
function level(answer: string) {
  const calls: string[] = [];
  return { calls, level: createFakeLevel({ name: 'level-1', script: (req) => { calls.push(req.question.text); return { answer, escalate: false, reason: 'clear', confidence: 'high' }; } }) };
}

async function start(seams: Parameters<typeof startTestApp>[0]['seams']): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, ...(seams ? { seams } : {}) });
  return t;
}

const ask = (message: string) => ({ op: 'ask', message });
const fail = (message: string) => ({ op: 'fail', message, ms: 0 });
const PICK = 'Which name should the new module take?\n1. ledger\n2. journal\n3. book';
const view = async (a: TestApp) => (await a.api<MinorDecisionsView>('GET', '/api/minor-decisions')).body;
const ofType = async (a: TestApp, type: string, jobId: string): Promise<DomainEvent[]> =>
  (await a.events(`types=${type}&limit=1000`)).filter((e) => e.jobId === jobId);

async function setPoint(a: TestApp, token: string, point: string, patch: Record<string, unknown>) {
  const r = await a.ui(`/ui/api/minor-decisions/points/${point}`, patch, { token });
  expect(r.status).toBe(200);
  return r.body;
}

describe('a question that lists its options, in shadow (the default)', () => {
  it('Jev picks first and is only recorded; the level answers; the pick is compared with its answer', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '2', confidence: 0.93 }));
    const l = level('2');
    const a = await start({ jev, levels: [l.level] });
    const job = await a.pull(ask(PICK), { title: 'add the module' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: '2' });
    expect(jev.asks).toHaveLength(1);
    expect(jev.asks[0]).toMatchObject({ point: 'question-answer', options: [{ id: '1', label: 'ledger' }, { id: '2', label: 'journal' }, { id: '3', label: 'book' }] });
    expect(l.calls).toHaveLength(1);
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ point: 'question-answer', by: 'jev', pick: '2', confidence: 0.93, mode: 'shadow', applied: false, notApplied: 'shadow' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ answeredBy: 'level-1' });
    // On the question's trail: Jev's pick first, then the level that answered.
    expect(q!.attempts.map((x) => [x.tier, x.role, x.outcome])).toEqual([['jev', 'jev', 'escalated'], ['level-1', 'level', 'accepted']]);
    const compared = await waitFor(async () => (await ofType(a, 'minor_decision.compared', job.id))[0]);
    expect(compared.data).toMatchObject({ pickId: picked!.data.pickId, pick: '2', actual: '2', agreed: true, decidedBy: 'level-1' });
    const v = await view(a);
    expect(v.jev).toEqual({ available: true });
    expect(v.points.find((p) => p.point === 'question-answer')).toMatchObject({ mode: 'shadow', asked: 1, picked: 1, applied: 0, compared: 1, agreed: 1, agreement: 1 });
    expect(v.recent[0]).toMatchObject({ point: 'question-answer', jobId: job.id, pick: '2', actual: '2', agreed: true, applied: false });
  });

  it('a question without listed options is not a decider call: Jev is not asked', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '1', confidence: 1 }));
    const a = await start({ jev, levels: [level('blue').level] });
    const job = await a.pull(ask('Which colour?'));
    await a.waitForStatus(job.id, 'finished');
    expect(jev.asks).toHaveLength(0);
    expect(await ofType(a, 'minor_decision.picked', job.id)).toEqual([]);
  });
});

describe('a question, active', () => {
  it('a confident pick is the answer: no level is asked, the job resumes with it', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '3', confidence: 0.97 }));
    const l = level('1');
    const a = await start({ jev, levels: [l.level] });
    const token = await a.login();
    // Settings live in the database and apply without a restart.
    expect(await setPoint(a, token, 'question-answer', { mode: 'active', threshold: 0.9 })).toMatchObject({ mode: 'active', threshold: 0.9 });
    const job = await a.pull(ask(PICK));
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: '3' });
    expect(l.calls).toHaveLength(0);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'jev', answer: '3' });
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ applied: true, mode: 'active', threshold: 0.9 });
    expect((await ofType(a, 'question.answered', job.id))[0]!.data).toMatchObject({ by: 'jev', answer: '3' });
    expect((await a.events('types=minor_decision.settings_changed&limit=10'))[0]!.data).toMatchObject({ point: 'question-answer', to: { mode: 'active', threshold: 0.9 } });
  });

  it('below the threshold the question escalates as before', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '3', confidence: 0.6 }));
    const l = level('1');
    const a = await start({ jev, levels: [l.level] });
    await setPoint(a, await a.login(), 'question-answer', { mode: 'active' });
    const job = await a.pull(ask(PICK));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: '1' });
    expect(l.calls).toHaveLength(1);
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ applied: false, notApplied: 'below_threshold' });
    const compared = await waitFor(async () => (await ofType(a, 'minor_decision.compared', job.id))[0]);
    expect(compared.data).toMatchObject({ pick: '3', actual: '1', agreed: false });
  });

  it('never for a consequential action: an option that deletes escalates, whatever Jev says', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '1', confidence: 0.99 }));
    const l = level('2');
    const a = await start({ jev, levels: [l.level] });
    await setPoint(a, await a.login(), 'question-answer', { mode: 'active' });
    const job = await a.pull(ask('The old branch is merged. What now?\n1. Delete the branch\n2. Leave it'));
    // The level is asked; the risk rules then send the question to a person, as they always did.
    const [q] = await waitFor(async () => { const qs = await a.questionsOf(job.id); return qs[0]?.tier === 'human' ? qs : undefined; }, { what: 'the question with a person' });
    expect(q!.status).toBe('open');
    expect(l.calls).toHaveLength(1);
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ applied: false, notApplied: 'consequential', consequential: ['delete'] });
  });

  it('Jev failing is no answer: the question goes on to the level', async () => {
    const jev = fakeJev(() => ({ ok: false, why: 'TypeSafe answered 503' }));
    const l = level('1');
    const a = await start({ jev, levels: [l.level] });
    await setPoint(a, await a.login(), 'question-answer', { mode: 'active' });
    const job = await a.pull(ask(PICK));
    await a.waitForStatus(job.id, 'finished');
    expect(l.calls).toHaveLength(1);
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ applied: false, notApplied: 'no_pick', error: 'TypeSafe answered 503' });
  });
});

describe('a failed job no rule explains', () => {
  const RETRY = (x: MinorDecisionAsk): JevPick => ({ ok: true, pick: x.options.find((o) => o.id === 'retry') ? 'retry' : x.options[0]!.id, confidence: 0.95 });

  it('in shadow: Jev picks retry or a person; a person running it again is what was decided', async () => {
    const jev = fakeJev(RETRY);
    const a = await start({ jev });
    const job = await a.pull(fail('HOPPER_FAILED the build step printed nothing'));
    await a.waitForStatus(job.id, 'failed');
    const picked = await waitFor(async () => (await ofType(a, 'minor_decision.picked', job.id))[0], { what: 'Jev asked about the failure' });
    expect(picked.data).toMatchObject({ point: 'failure-assessment', pick: 'retry', applied: false, notApplied: 'shadow' });
    expect(jev.asks[0]!.options.map((o) => o.id)).toEqual(['retry', 'person']);
    expect(jev.asks[0]!.state).toMatchObject({ error: 'HOPPER_FAILED the build step printed nothing' });
    // Rules decided, and the hand-off stands: a person runs it again from Needs a person.
    const token = await a.login();
    const handoff = await waitFor(async () => (await a.api<{ handoffs: { id: string; jobId: string }[] }>('GET', '/api/failures')).body.handoffs.find((h) => h.jobId === job.id));
    expect((await a.ui(`/ui/api/failures/handoffs/${handoff.id}/resolve`, { action: 'fixed' }, { token })).status).toBe(200);
    const compared = await waitFor(async () => (await ofType(a, 'minor_decision.compared', job.id))[0]);
    expect(compared.data).toMatchObject({ pick: 'retry', actual: 'retry', agreed: true, decidedBy: 'person' });
  });

  it('active: a confident retry runs it again by itself', async () => {
    const jev = fakeJev(RETRY);
    const a = await start({ jev });
    await setPoint(a, await a.login(), 'failure-assessment', { mode: 'active' });
    const job = await a.pull(fail('HOPPER_FAILED the build step printed nothing'));
    await a.waitForStatus(job.id, 'failed');
    const rerun = await waitFor(async () => (await ofType(a, 'job.rerun', job.id))[0], { what: 'run again by Jev' });
    expect(rerun.data).toMatchObject({ by: 'assessor' });
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ applied: true, pick: 'retry' });
  });

  it('a done-check miss (issue #637): its source not done again, Jev picks run it again or a person; active and sure, it runs again', async () => {
    const jev = fakeJev(RETRY);
    const a = await start({ jev });
    await setPoint(a, await a.login(), 'failure-assessment', { mode: 'active' });
    const job = await a.pull(fail('not complete: the issue https://github.com/o/r/issues/1 is open, and no pull request in o/r closes or references it'));
    const rerun = await waitFor(async () => (await ofType(a, 'job.rerun', job.id))[0], { what: 'run again by Jev' });
    expect(rerun.data).toMatchObject({ by: 'assessor' });
    expect(jev.asks[0]!.options.map((o) => o.id)).toEqual(['retry', 'person']);
    expect(jev.asks[0]!.instructions).toMatch(/said it was done/);
    expect(jev.asks[0]!.state).toMatchObject({ error: expect.stringMatching(/^not complete:/) });
  });

  it('a known cause is the rules\' decision: Jev is not asked', async () => {
    const jev = fakeJev(RETRY);
    const a = await start({ jev });
    const job = await a.pull(fail('read ECONNRESET'));
    await a.waitForStatus(job.id, 'failed');
    await waitFor(async () => (await ofType(a, 'job.assessed', job.id))[0]);
    expect(jev.asks).toHaveLength(0);
  });
});

describe('overrides and the view', () => {
  it('a person overrides a pick: it counts as a disagreement, and is on the job\'s events', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '1', confidence: 0.99 }));
    const a = await start({ jev, levels: [level('1').level] });
    const token = await a.login();
    await setPoint(a, token, 'question-answer', { mode: 'active' });
    const job = await a.pull(ask(PICK));
    await a.waitForStatus(job.id, 'finished');
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    const r = await a.ui(`/ui/api/minor-decisions/picks/${picked!.data.pickId as string}/override`, { actual: '2' }, { token });
    expect(r.status).toBe(200);
    expect((await ofType(a, 'minor_decision.overridden', job.id))[0]!.data).toMatchObject({ pick: '1', actual: '2' });
    const v = await view(a);
    expect(v.points.find((p) => p.point === 'question-answer')).toMatchObject({ applied: 1, compared: 1, agreed: 0, agreement: 0, overridden: 1 });
    expect(v.recent[0]).toMatchObject({ actual: '2', overridden: true, agreed: false });
    // An option the decision did not offer is refused.
    expect((await a.ui(`/ui/api/minor-decisions/picks/${picked!.data.pickId as string}/override`, { actual: '9' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/minor-decisions/picks/nope/override', { actual: '1' }, { token })).status).toBe(404);
  });

  it('settings: refuses what is not a mode or a threshold', async () => {
    const a = await start({ jev: fakeJev(() => ({ ok: false, why: 'unused' })) });
    const token = await a.login();
    expect((await a.ui('/ui/api/minor-decisions/points/question-answer', { mode: 'loud' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/minor-decisions/points/question-answer', { threshold: 1.5 }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/minor-decisions/points/nowhere', { mode: 'off' }, { token })).status).toBe(404);
    const v = await view(a);
    expect(v.points.map((p) => [p.point, p.mode, p.threshold])).toEqual([['question-answer', 'shadow', 0.85], ['failure-assessment', 'shadow', 0.85]]);
  });

  it('off: Jev is not asked', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: '1', confidence: 1 }));
    const a = await start({ jev, levels: [level('1').level] });
    await setPoint(a, await a.login(), 'question-answer', { mode: 'off' });
    const job = await a.pull(ask(PICK));
    await a.waitForStatus(job.id, 'finished');
    expect(jev.asks).toHaveLength(0);
  });
});

describe('without the TypeSafe key', () => {
  it('nothing is asked and nothing recorded; the view says why', async () => {
    const l = level('1');
    const a = await start({ levels: [l.level] });
    const job = await a.pull(ask(PICK));
    await a.waitForStatus(job.id, 'finished');
    expect(l.calls).toHaveLength(1);
    expect(await ofType(a, 'minor_decision.picked', job.id)).toEqual([]);
    expect((await view(a)).jev).toMatchObject({ available: false, why: expect.stringContaining('TYPESAFE_API_KEY') });
  });
});
