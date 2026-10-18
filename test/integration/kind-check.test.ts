// Issue #655: Jev's kind check, end to end. The daemon, store and HTTP edge are real; Jev is a double at its seam
// (`seams.jev`). A manual source's job is a work job from a job source, on the test executor, which writes reviews.
//
// Feature: Jev's kind check (the decision point `intake-kind`)
//   Scenario: in shadow (the default), Jev is asked and the job does the work
//   Scenario: active, Jev keeps the work: the job runs, the check on the job
//   Scenario: active, Jev picks research: the job is asked for research before it starts
//   Scenario: active, Jev gives no answer: the job does the work as it was asked
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

/** Jev as a double: at `intake-kind` picks what `answer` says; no pick elsewhere. Records the kind asks. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => {
      if (ask.point !== 'intake-kind') return { ok: false, why: 'unused' };
      asks.push(ask);
      return answer(ask);
    },
    choose: async () => ({ ok: false, why: 'unused' }),
    check: async () => ({ ok: true }),
  };
}

async function start(jev: JevChooser, mode?: 'active'): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { jev } });
  const token = await t.login();
  if (mode) expect((await t.ui('/ui/api/minor-decisions/points/intake-kind', { mode }, { token })).status).toBe(200);
  return t;
}

const ok = { op: 'sleep', ms: 0 };
const stored = (a: TestApp, id: string): Job => a.user(ADMIN_ID).store.jobs.get(id)!;
const ofType = async (a: TestApp, type: string, jobId: string): Promise<DomainEvent[]> =>
  (await a.events(`types=${type}&limit=1000`)).filter((e) => e.jobId === jobId);

describe('Jev\'s kind check (issue #655)', () => {
  it('in shadow, asks Jev and the job does the work', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: 'research', confidence: 0.99 }));
    const a = await start(jev);
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect(jev.asks.map((x) => x.options.map((o) => o.id))[0]).toEqual(['keep', 'research', 'proposal']);
    expect(jev.asks[0]!.state).toMatchObject({ job: { id: job.id }, untrustedText: JSON.stringify(ok) });
    expect(stored(a, job.id).spec.research).toBeUndefined();
    expect(stored(a, job.id).kindCheck).toBeUndefined();
    expect(await ofType(a, 'research.asked', job.id)).toEqual([]);
    const picked = await waitFor(async () => (await ofType(a, 'minor_decision.picked', job.id)).find((e) => e.data.point === 'intake-kind'));
    expect(picked.data).toMatchObject({ point: 'intake-kind', pick: 'research', mode: 'shadow', applied: false, notApplied: 'shadow' });
  });

  it('active, a kept kind lets the job do the work, with the check on the job', async () => {
    const a = await start(fakeJev(() => ({ ok: true, pick: 'keep', confidence: 0.95 })), 'active');
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect(stored(a, job.id).kindCheck).toEqual({ pick: 'keep', confidence: 0.95, applied: true });
    expect(stored(a, job.id).spec.research).toBeUndefined();
  });

  it('active, a pick of research asks the job for research before it starts', async () => {
    const a = await start(fakeJev(() => ({ ok: true, pick: 'research', confidence: 0.95 })), 'active');
    const job = await a.pull(ok);
    const asked = await waitFor(async () => (await ofType(a, 'research.asked', job.id))[0], { what: 'the research asked by Jev' });
    expect(asked.data).toEqual({ by: 'jev' });
    const j = stored(a, job.id);
    expect(j.spec.research).toBe(true);
    expect(j.kindCheck).toEqual({ pick: 'research', confidence: 0.95, applied: true, kind: 'research' });
    // It was asked before it started: its first start is as a research job.
    const started = (await ofType(a, 'job.claimed', job.id))[0];
    expect(started === undefined || started.seq > asked.seq).toBe(true);
  });

  it('active, no answer keeps the work (the kind is no gate)', async () => {
    const a = await start(fakeJev(() => ({ ok: false, why: 'TypeSafe is down' })), 'active');
    const job = await a.pull(ok);
    await a.waitForStatus(job.id, 'finished');
    expect(stored(a, job.id).kindCheck).toEqual({ applied: false, fail: 'no_answer' });
    expect(stored(a, job.id).spec.research).toBeUndefined();
  });
});
