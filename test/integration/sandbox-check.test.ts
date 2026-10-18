// Issue #655 part 13: Jev's sandbox check (the decision point `sandbox-request`), end to end. The daemon, store and HTTP
// edge are real; Jev is a double at its seam (`seams.jev`). Sandbox YOLO approves every run with no person, so under the
// default sandbox strictness (`standard`) Jev checks each run of a template not of low blast radius.
//
// Feature: Jev's sandbox check
//   Scenario: in shadow (the default), the toggle approves the run, and Jev is asked only to record
//   Scenario: active, Jev allows the run: approved by Jev
//   Scenario: active, Jev denies the run: declined by Jev, and the job's trust one level lower
//     Then below approved its next run waits for a person, not Jev; a person's decline is the second deny, and quarantines it
import { afterEach, describe, expect, it } from 'vitest';
import type { JevChooser, JevPick, MinorDecisionAsk } from '../../src/domain/types.ts';
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

/** Jev as a double: at `sandbox-request` picks what `answer` says; no pick elsewhere. Records the sandbox asks. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => {
      if (ask.point !== 'sandbox-request') return { ok: false, why: 'unused' };
      asks.push(ask);
      return answer(ask);
    },
    choose: async () => ({ ok: false, why: 'unused' }),
    check: async () => ({ ok: true }),
  };
}

async function start(jev: JevChooser, mode?: 'active'): Promise<{ a: TestApp; jobId: string; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { jev } });
  const token = await t.login();
  if (mode) expect((await t.ui('/ui/api/minor-decisions/points/sandbox-request', { mode }, { token })).status).toBe(200);
  expect((await t.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);
  const job = await t.pull({ op: 'sleep', ms: 60000 });
  await t.waitForStatus(job.id, 'running', 10000);
  return { a: t, jobId: job.id, token };
}

const request = (a: TestApp, id: string) => a.user(ADMIN_ID).sandboxRequests.list().find((r) => r.id === id);
const level = (a: TestApp, jobId: string) => a.user(ADMIN_ID).store.jobs.get(jobId)!.stamp!.level;

describe('Jev\'s sandbox check (issue #655 part 13)', () => {
  it('in shadow, the toggle approves the run, and Jev is asked only to record', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: 'deny:out_of_scope', confidence: 0.99 }));
    const { a, jobId } = await start(jev);
    expect(a.user(ADMIN_ID).sandboxRequests.ask(jobId, 'aws-prod')).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    await waitFor(() => jev.asks.length === 1, { timeoutMs: 5000 });
    expect(jev.asks[0]!.state).toMatchObject({ request: { template: 'aws-prod', approver: 'skip sandbox approval' }, job: { id: jobId, level: 'approved' } });
    expect(level(a, jobId)).toBe('approved');
  });

  it('active, Jev allows the run: approved by Jev', async () => {
    const { a, jobId } = await start(fakeJev(() => ({ ok: true, pick: 'allow', confidence: 0.99 })), 'active');
    const r = a.user(ADMIN_ID).sandboxRequests.ask(jobId, 'aws-prod');
    expect(r).toMatchObject({ state: 'waiting', jev: { state: 'checking' } });
    await waitFor(() => request(a, r.id)?.state === 'approved', { timeoutMs: 5000 });
    expect(request(a, r.id)).toMatchObject({ approvedBy: 'Jev' });
    expect((await a.events('types=vault.sandbox_approved')).map((e) => e.data)).toEqual([expect.objectContaining({ by: 'Jev' })]);
  });

  it('active, Jev denies: declined by Jev, the job one level lower; a person\'s decline then is the second deny', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: 'deny:pattern_suspicious', confidence: 0.99 }));
    const { a, jobId, token } = await start(jev, 'active');
    const r = a.user(ADMIN_ID).sandboxRequests.ask(jobId, 'aws-prod');
    await waitFor(() => request(a, r.id)?.state === 'declined', { timeoutMs: 5000 });
    expect(request(a, r.id)).toMatchObject({ declinedBy: 'Jev' });
    await waitFor(() => level(a, jobId) === 'screened', { timeoutMs: 5000 });
    expect((await a.events('types=job.trust_lowered')).map((e) => e.data)).toEqual([{ from: 'approved', to: 'screened', reason: 'deny:jev', by: 'jev' }]);
    // Below approved, gate 2 approves nothing with no person (part 7), so Jev is not asked: the run waits for a person.
    const second = a.user(ADMIN_ID).sandboxRequests.ask(jobId, 'aws-dev');
    expect(second.state).toBe('waiting');
    expect(second.jev).toBeUndefined();
    expect(jev.asks).toHaveLength(1);
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'decline', id: second.id, reason: 'no' }, { token })).status).toBe(200);
    expect(level(a, jobId)).toBe('quarantined');
    expect((await a.events('types=job.quarantined')).map((e) => e.data)).toEqual([expect.objectContaining({ was: 'screened', reason: 'deny:sandbox' })]);
  });
});
