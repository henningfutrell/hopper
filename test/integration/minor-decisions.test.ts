// Decider calls through Jev first (issue #550), end to end: the real daemon and database, Jev as a double at its
// seam (`seams.jev`), escalation levels as doubles. A failure no rule explains asks Jev first; a level's answer to a
// question gets Jev's risk call (issue #679). In shadow (the default) Jev's decision is recorded and compared with what was
// decided; active, it is applied as each point says, and anything else goes on as before. Every pick is an event on its
// job; a person overrides one; the agreement rates show per decision point. Without Jev nothing is asked.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, JevChoices, JevChoicesAsk, JevChooser, JevPick, MinorDecisionAsk, MinorDecisionsView, RiskCategory, RiskLevel } from '../../src/domain/types.ts';
import { ADMIN_ID, DEFAULT_MINOR_DECISION_SETTINGS } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { resolveHandoff } from '../support/give-back.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** Jev as a double: picks what `answer` says, makes the risk call `risk` says (default: none, sure), records every ask. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick, risk: (ask: JevChoicesAsk) => JevChoices = () => riskPicks('none', [], 0.95)): JevChooser & { asks: MinorDecisionAsk[]; risks: JevChoicesAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  const risks: JevChoicesAsk[] = [];
  return {
    asks, risks,
    available: () => ({ available: true }),
    pick: async (ask) => { asks.push(ask); return answer(ask); },
    choose: async (ask) => { risks.push(ask); return risk(ask); },
    check: async () => ({ ok: true }),
  };
}

/** Jev's risk call answering `risk` with these kinds, at `confidence`. */
function riskPicks(risk: RiskLevel, categories: RiskCategory[], confidence: number): JevChoices {
  const kinds = ['credentials', 'destructive', 'publish', 'pay', 'permissions', 'ci', 'data', 'other'] as const;
  return { ok: true, picks: { risk: { pick: risk, confidence }, ...Object.fromEntries(kinds.map((k) => [k, { pick: categories.includes(k) ? 'yes' : 'no', confidence }])) } };
}
const NO_PICK = () => ({ ok: false as const, why: 'unused' });

/** A level that answers every question with `answer`, and counts its calls. */
function level(answer: string) {
  const calls: string[] = [];
  return { calls, level: createFakeLevel({ name: 'level-1', script: (req) => { calls.push(req.question.text); return { answer, escalate: false, reason: 'clear', confidence: 'high' }; } }) };
}

async function start(seams: Parameters<typeof startTestApp>[0]['seams']): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, ...(seams ? { seams } : {}) });
  // Jev's trust check (issue #655 part 4) is asked for every job these tests pull: off, so each test reads its own point's picks.
  t.user(ADMIN_ID).store.settings.setMinorDecisionSettings({ ...DEFAULT_MINOR_DECISION_SETTINGS, 'intake-trust': { mode: 'off', threshold: 0.85 } });
  return t;
}

const ask = (message: string) => ({ op: 'ask', message });
const fail = (message: string) => ({ op: 'fail', message, ms: 0 });
const QUESTION = 'This CI step uses no secrets. May I add it?';
const view = async (a: TestApp) => (await a.api<MinorDecisionsView>('GET', '/api/minor-decisions')).body;
const ofType = async (a: TestApp, type: string, jobId: string): Promise<DomainEvent[]> =>
  (await a.events(`types=${type}&limit=1000`)).filter((e) => e.jobId === jobId);

async function setPoint(a: TestApp, token: string, point: string, patch: Record<string, unknown>) {
  const r = await a.ui(`/ui/api/minor-decisions/points/${point}`, patch, { token });
  expect(r.status).toBe(200);
  return r.body;
}

describe('the risk call on a level\'s answer (issue #679), in shadow (the default)', () => {
  it('Jev\'s risk decision is recorded next to the keyword rules, which decide; the two are compared at once', async () => {
    const jev = fakeJev(NO_PICK, () => riskPicks('real', ['credentials', 'ci'], 0.93));
    const l = level('yes');
    const a = await start({ jev, levels: [l.level] });
    const job = await a.pull(ask(QUESTION), { title: 'add the step' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'yes' });
    expect(jev.risks).toHaveLength(1);
    expect(jev.risks[0]!.state).toEqual({ question: QUESTION, answer: 'yes', level: 'level-1', goal: expect.any(String) });
    expect(Object.keys(jev.risks[0]!.choices)).toEqual(['risk', 'credentials', 'destructive', 'publish', 'pay', 'permissions', 'ci', 'data', 'other']);
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ point: 'question-risk', by: 'jev', pick: 'real', categories: ['credentials', 'ci'], confidence: 0.93, mode: 'shadow', applied: false, notApplied: 'shadow' });
    const [compared] = await ofType(a, 'minor_decision.compared', job.id);
    expect(compared!.data).toMatchObject({ pickId: picked!.data.pickId, pick: 'real', actual: 'none', agreed: false, decidedBy: 'rules' });
    const [q] = await a.questionsOf(job.id);
    expect(q!.attempts[0]).toMatchObject({ riskCheck: { by: 'rules', shadow: true, decision: { risk: 'real', categories: ['credentials', 'ci'], confidence: 0.93 } } });
    const v = await view(a);
    expect(v.points.find((p) => p.point === 'question-risk')).toMatchObject({ mode: 'shadow', asked: 1, picked: 1, applied: 0, compared: 1, agreed: 0, agreement: 0 });
    expect(v.recent[0]).toMatchObject({ point: 'question-risk', questionId: q!.id, pick: 'real', categories: ['credentials', 'ci'], actual: 'none', agreed: false });
  });
});

describe('the risk call, active: it replaces the keyword risk rules', () => {
  it('"uses no secrets": no risk, sure, so the level\'s answer goes into the job', async () => {
    const jev = fakeJev(NO_PICK, () => riskPicks('none', [], 0.95));
    const a = await start({ jev, levels: [level('yes').level] });
    await setPoint(a, await a.login(), 'question-risk', { mode: 'active', threshold: 0.9 });
    const job = await a.pull(ask(QUESTION));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'yes' });
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    expect(picked!.data).toMatchObject({ point: 'question-risk', pick: 'none', applied: true, mode: 'active', threshold: 0.9 });
  });

  it('"rotate the GitHub token": a real credentials risk sends it to a person, the kinds on the escalation', async () => {
    const jev = fakeJev(NO_PICK, () => riskPicks('real', ['credentials'], 0.97));
    const a = await start({ jev, levels: [level('yes').level] });
    await setPoint(a, await a.login(), 'question-risk', { mode: 'active' });
    const job = await a.pull(ask('May I rotate the GitHub token?'));
    const [q] = await waitFor(async () => { const qs = await a.questionsOf(job.id); return qs[0]?.tier === 'human' ? qs : undefined; }, { what: 'the question with a person' });
    expect(q).toMatchObject({ status: 'open', keptBy: 'risk', escalation: { reason: 'guard', holds: [{ reason: 'guard', by: 'risk', decider: { risk: 'real', categories: ['credentials'], confidence: 0.97, threshold: 0.85 } }] } });
    expect((await ofType(a, 'question.escalated_to_human', job.id))[0]!.data).toMatchObject({ holds: [expect.objectContaining({ decider: expect.objectContaining({ categories: ['credentials'] }) })] });
  });

  it('Jev failing holds the question (fail closed), and says why', async () => {
    const jev = fakeJev(NO_PICK, () => ({ ok: false, why: 'TypeSafe answered 503' }));
    const a = await start({ jev, levels: [level('yes').level] });
    await setPoint(a, await a.login(), 'question-risk', { mode: 'active' });
    const job = await a.pull(ask(QUESTION));
    const [q] = await waitFor(async () => { const qs = await a.questionsOf(job.id); return qs[0]?.tier === 'human' ? qs : undefined; }, { what: 'the question with a person' });
    expect(q!.escalation).toMatchObject({ holds: [{ by: 'risk', decider: { error: 'TypeSafe answered 503' } }], riskCheck: { by: 'decider', error: 'TypeSafe answered 503' } });
    expect((await ofType(a, 'minor_decision.picked', job.id))[0]!.data).toMatchObject({ applied: false, notApplied: 'no_pick', error: 'TypeSafe answered 503' });
  });

  it('the guards always hold: deleting goes to a person, whatever Jev says', async () => {
    const jev = fakeJev(NO_PICK, () => riskPicks('none', [], 0.99));
    const a = await start({ jev, levels: [level('yes').level] });
    await setPoint(a, await a.login(), 'question-risk', { mode: 'active' });
    const job = await a.pull(ask('The old branch is merged. Shall I delete it?'));
    const [q] = await waitFor(async () => { const qs = await a.questionsOf(job.id); return qs[0]?.tier === 'human' ? qs : undefined; }, { what: 'the question with a person' });
    expect(q).toMatchObject({ keptBy: 'guard', escalation: { holds: [{ reason: 'guard', by: 'guard', guards: [expect.objectContaining({ name: 'delete' })] }] } });
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
    expect((await resolveHandoff(a, handoff.id, { action: 'fixed' }, token)).status).toBe(200);
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
    const jev = fakeJev(NO_PICK, () => riskPicks('none', [], 0.99));
    const a = await start({ jev, levels: [level('yes').level] });
    const token = await a.login();
    await setPoint(a, token, 'question-risk', { mode: 'active' });
    const job = await a.pull(ask(QUESTION));
    await a.waitForStatus(job.id, 'finished');
    const [picked] = await ofType(a, 'minor_decision.picked', job.id);
    const r = await a.ui(`/ui/api/minor-decisions/picks/${picked!.data.pickId as string}/override`, { actual: 'real' }, { token });
    expect(r.status).toBe(200);
    expect((await ofType(a, 'minor_decision.overridden', job.id))[0]!.data).toMatchObject({ pick: 'none', actual: 'real' });
    const v = await view(a);
    expect(v.points.find((p) => p.point === 'question-risk')).toMatchObject({ applied: 1, compared: 1, agreed: 0, agreement: 0, overridden: 1 });
    expect(v.recent[0]).toMatchObject({ actual: 'real', overridden: true, agreed: false });
    // An option the decision did not offer is refused.
    expect((await a.ui(`/ui/api/minor-decisions/picks/${picked!.data.pickId as string}/override`, { actual: '9' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/minor-decisions/picks/nope/override', { actual: '1' }, { token })).status).toBe(404);
  });

  it('settings: refuses what is not a mode or a threshold', async () => {
    const a = await start({ jev: fakeJev(() => ({ ok: false, why: 'unused' })) });
    const token = await a.login();
    expect((await a.ui('/ui/api/minor-decisions/points/question-risk', { mode: 'loud' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/minor-decisions/points/question-risk', { threshold: 1.5 }, { token })).status).toBe(400);
    // The point Jev answered questions at is gone (issue #679): the Decider is not a question answerer.
    expect((await a.ui('/ui/api/minor-decisions/points/question-answer', { mode: 'off' }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/minor-decisions/points/nowhere', { mode: 'off' }, { token })).status).toBe(404);
    const v = await view(a);
    expect(v.points.map((p) => [p.point, p.mode, p.threshold])).toEqual([
      ['question-risk', 'shadow', 0.85], ['failure-assessment', 'shadow', 0.85], ['lane-count', 'shadow', 0.85], ['job-machine', 'shadow', 0.85],
      ['intake-order', 'shadow', 0.85], ['merge-order', 'shadow', 0.85], ['intake-trust', 'off', 0.85],
    ]);
  });

  it('off: Jev is not asked', async () => {
    const jev = fakeJev(NO_PICK, () => riskPicks('real', ['credentials'], 1));
    const a = await start({ jev, levels: [level('yes').level] });
    await setPoint(a, await a.login(), 'question-risk', { mode: 'off' });
    const job = await a.pull(ask(QUESTION));
    await a.waitForStatus(job.id, 'finished');
    expect(jev.risks).toHaveLength(0);
  });
});

describe('without the TypeSafe key', () => {
  it('nothing is asked and nothing recorded; the keyword rules check the answer, and the view says why', async () => {
    const l = level('yes');
    const a = await start({ levels: [l.level] });
    const job = await a.pull(ask(QUESTION));
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'yes' });
    expect(l.calls).toHaveLength(1);
    expect(await ofType(a, 'minor_decision.picked', job.id)).toEqual([]);
    expect((await a.questionsOf(job.id))[0]!.attempts[0]).toMatchObject({ riskRules: [], riskCheck: { by: 'rules' } });
    expect((await view(a)).jev).toMatchObject({ available: false, why: 'Jev is off until a TypeSafe API key is set' });
  });
});
