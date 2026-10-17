// Issue #655 part 4: Jev's trust check, end to end. The daemon, store and HTTP edge are real; Jev is a double at its seam
// (`seams.jev`). A manual source's job is `approved` by the rules, so it is checked.
//
// Feature: Jev's trust check (the decision point `intake-trust`)
//   Scenario: in shadow (the default), Jev is asked and the job runs on the rules' level
//   Scenario: active, Jev keeps the level: the job runs, the check on its stamp
//   Scenario: active, Jev lowers it: the job is held with the reason; a person approves its trust, and it runs
//   Scenario: active, Jev gives no answer: the job is held (fail closed)
//   Scenario: a job no check lowered cannot have its trust approved: 409; no such job: 404
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, JevChooser, JevPick, Job, MinorDecisionAsk } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** Jev as a double: at `intake-trust` picks what `answer` says; no pick elsewhere. Records the trust asks. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => {
      if (ask.point !== 'intake-trust') return { ok: false, why: 'unused' };
      asks.push(ask);
      return answer(ask);
    },
    choose: async () => ({ ok: false, why: 'unused' }),
    check: async () => ({ ok: true }),
  };
}

async function start(jev: JevChooser, mode?: 'active'): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { jev } });
  const token = await t.login();
  if (mode) expect((await t.ui('/ui/api/minor-decisions/points/intake-trust', { mode }, { token })).status).toBe(200);
  return { a: t, token };
}

const ok = { op: 'sleep', ms: 0 };
const stored = (a: TestApp, id: string): Job => a.user(ADMIN_ID).store.jobs.get(id)!;
const ofType = async (a: TestApp, type: string, jobId: string): Promise<DomainEvent[]> =>
  (await a.events(`types=${type}&limit=1000`)).filter((e) => e.jobId === jobId);

describe('Jev\'s trust check (issue #655 part 4)', () => {
  it('in shadow, asks Jev and runs the job on the rules\' level', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: 'lower:untrusted:touches_ci', confidence: 0.99 }));
    const { a } = await start(jev);
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect(jev.asks.length).toBeGreaterThan(0);
    expect(jev.asks[0]!.options[0]!.id).toBe('keep');
    expect(jev.asks[0]!.state).toMatchObject({ job: { id: job.id, level: 'approved' }, untrustedText: JSON.stringify(ok) });
    expect(stored(a, job.id).stamp).toMatchObject({ level: 'approved', by: 'intake' });
    expect(stored(a, job.id).stamp!.check).toBeUndefined();
    expect(await ofType(a, 'job.trust_lowered', job.id)).toEqual([]);
    const picked = await waitFor(async () => (await ofType(a, 'minor_decision.picked', job.id))[0]);
    expect(picked.data).toMatchObject({ point: 'intake-trust', pick: 'lower:untrusted:touches_ci', mode: 'shadow', applied: false, notApplied: 'shadow' });
  });

  it('active, a kept level lets the job run, with the check on its stamp', async () => {
    const { a } = await start(fakeJev(() => ({ ok: true, pick: 'keep', confidence: 0.95 })), 'active');
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect(stored(a, job.id).stamp).toMatchObject({ level: 'approved', by: 'jev', check: { pick: 'keep', confidence: 0.95, applied: true } });
    expect(await ofType(a, 'job.trust_lowered', job.id)).toEqual([]);
  });

  it('active, a lowered level holds the job until a person approves its trust', async () => {
    const { a, token } = await start(fakeJev(() => ({ ok: true, pick: 'lower:untrusted:touches_ci', confidence: 0.95 })), 'active');
    const job = await a.pull(ok);
    const held = await waitFor(async () => { const j = stored(a, job.id); return j.status === 'held' && j.holdReason?.includes('Jev\'s trust check') ? j : undefined; }, { what: 'the job held by the check' });
    expect(held.holdReason).toBe('trust stamp untrusted is below approved (Jev\'s trust check: it changes CI, workflow files or branch rules): held — a person approves its trust on the job, or cancels it');
    expect(held.stamp).toMatchObject({ level: 'untrusted', by: 'jev', reasons: ['source:configured', 'jev:touches_ci'] });
    expect((await ofType(a, 'job.trust_lowered', job.id)).map((e) => e.data)).toEqual([{ from: 'approved', to: 'untrusted', reason: 'jev:touches_ci', by: 'jev' }]);

    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/approve-trust`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.stamp).toMatchObject({ level: 'approved', by: 'person' });
    await a.waitForStatus(job.id, 'finished');
    expect((await ofType(a, 'job.trust_approved', job.id)).map((e) => e.data)).toEqual([expect.objectContaining({ from: 'untrusted', via: 'ui' })]);
    // Approved once: a second approval has nothing to approve.
    expect((await a.ui(`/ui/api/jobs/${job.id}/approve-trust`, {}, { token })).status).toBe(409);
  });

  it('active, no answer holds the job (fail closed)', async () => {
    const { a } = await start(fakeJev(() => ({ ok: false, why: 'TypeSafe is down' })), 'active');
    const job = await a.pull(ok);
    const held = await waitFor(async () => { const j = stored(a, job.id); return j.stamp?.by === 'jev' && j.status === 'held' ? j : undefined; }, { what: 'the job held for no answer' });
    expect(held.stamp).toMatchObject({ level: 'untrusted', reasons: ['source:configured', 'jev:no_answer'], check: { applied: false, fail: 'no_answer' } });
    expect(held.holdReason).toContain('Jev gave no answer');
  });

  it('refuses to approve the trust of a job no check lowered, and of a job that is not there', async () => {
    const { a, token } = await start(fakeJev(() => ({ ok: true, pick: 'keep', confidence: 0.95 })));
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect((await a.ui(`/ui/api/jobs/${job.id}/approve-trust`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/jobs/nope/approve-trust', {}, { token })).status).toBe(404);
  });
});
