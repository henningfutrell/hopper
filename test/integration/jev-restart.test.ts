// Jev's step in the failure assessor across a restart (issue #1608): the step is kept on the failure record until Jev
// answers, so a daemon that stopped while Jev was asked asks again at its start. The real daemon and database, Jev a
// double at its seam (`seams.jev`).
import { afterEach, describe, expect, it } from 'vitest';
import type { JevChooser, JevPick, MinorDecisionAsk } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/**
 * Jev as a double: answers each pick with `answer` (a pick that never ends: undefined), records every ask. The trust check
 * and the kind check of each job pulled (issue #655, in shadow) get no pick, and are not recorded.
 */
function fakeJev(answer?: (ask: MinorDecisionAsk) => JevPick): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: (ask) => {
      if (ask.point === 'intake-trust' || ask.point === 'intake-kind') return Promise.resolve({ ok: false, why: 'unused' });
      asks.push(ask);
      return answer ? Promise.resolve(answer(ask)) : new Promise<JevPick>(() => {});
    },
    choose: async () => ({ ok: false, why: 'unused' }),
    check: async () => ({ ok: true }),
  };
}

const RETRY = (x: MinorDecisionAsk): JevPick => ({ ok: true, pick: x.options.find((o) => o.id === 'retry') ? 'retry' : x.options[0]!.id, confidence: 0.95 });

describe('Jev\'s step after a restart (issue #1608)', () => {
  it('the daemon stops while Jev is asked: after the start Jev is asked again, and the step is cleared once it answers', { timeout: 30_000 }, async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const before = fakeJev();
    t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { jev: before } });
    const r = await t.ui('/ui/api/minor-decisions/points/failure-assessment', { mode: 'active' }, { token: await t.login() });
    expect(r.status).toBe(200);
    const job = await t.pull({ op: 'fail', message: 'HOPPER_FAILED the build step printed nothing', ms: 0 });
    await t.waitForStatus(job.id, 'failed');
    await waitFor(() => before.asks.length === 1, { what: 'Jev asked about the failure' });
    expect(t.user().store.failures.forJob(job.id)?.jev).toMatchObject({ error: 'HOPPER_FAILED the build step printed nothing', attempt: 1 });
    await t.stop();

    const after = fakeJev(RETRY);
    t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { jev: after } });
    // The manual source of the new daemon does not hold the item, so the run again itself is refused: the pick is what counts.
    await waitFor(() => after.asks.length === 1, { what: 'Jev asked again after the restart', timeoutMs: 15_000 });
    expect(after.asks[0]!.state).toMatchObject({ error: 'HOPPER_FAILED the build step printed nothing' });
    await waitFor(() => t!.user().store.failures.forJob(job.id)?.jev === undefined, { what: 'the step cleared once Jev answered' });
  });
});
