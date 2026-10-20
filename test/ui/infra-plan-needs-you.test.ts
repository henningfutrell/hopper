// Issue #2205: an infra plan that waits for a person is in one place the owner sees at once. Needs you counts it in its
// Infra plans row and badge, names it with its summary and who approves it, and marks it when a high-priority job recorded
// it; a job that waits on the plan links to it on Infra, picked, where Approve is. Pure.
import { describe, expect, it } from 'vitest';
import { needsYouRows, needsYouTotal, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { planHref, planWaitingLines, plansHigh, plansWaiting } from '../../ui/src/model/infra-plans.ts';
import { waitOnLinkOf } from '../../ui/src/model/board.ts';
import type { PlanSummary, PlanView } from '../../src/domain/types.ts';

const ID = 'cc564657-1bd7-4a54-8484-958975d94524';
const now = Date.parse('2026-10-20T02:30:00.000Z');
const summary = { words: 'Restarts 1 statefulset in prod; destroys nothing', level: 'high', environments: ['prod'] } as PlanSummary;
const waiting: PlanView = {
  id: ID, tool: 'helm', asset: { kind: 'cluster', name: 'identity-eks' }, target: 'keycloak', repo: 'octo/infra', ref: 'restart', commit: 'a'.repeat(40),
  job: 'eb2d8545', createdAt: '2026-10-20T02:12:00.000Z', expiresAt: '2026-10-20T03:12:00.000Z', summary, approver: { who: 'admin', why: 'high risk: prod' },
};
const approved: PlanView = { ...waiting, id: '0f0e0d0c-0b0a-4908-8706-050403020100', job: 'other', approval: { plan: 'x', by: 'Ada', at: '2026-10-20T02:20:00.000Z' } };
const stale: PlanView = { ...waiting, id: '1f0e0d0c-0b0a-4908-8706-050403020100', expiresAt: '2026-10-20T02:00:00.000Z' };
const view = { plans: [waiting, approved, stale] };
const none = { n: 0, high: 0 };
const counts = (o: Partial<NeedsYouCounts>): NeedsYouCounts => ({
  intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0,
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none }, ...o,
});

describe('an infra plan a job waits on, in Needs you (issue #2205)', () => {
  it('counts only the plans that wait for a person, and names each with its summary and who approves it', () => {
    expect(plansWaiting(view, now)).toBe(1);
    expect(planWaitingLines(view, now)).toEqual(['plan cc564657: Restarts 1 statefulset in prod; destroys nothing (high risk). Waits for an admin']);
  });

  it('marks the plans a high-priority job recorded', () => {
    const jobs = { eb2d8545: { priority: 75 }, other: { priority: 75 } };
    expect(plansHigh(view, now, jobs, 70)).toBe(1);
    expect(plansHigh(view, now, jobs, 80)).toBe(0);
    expect(plansHigh(view, now, jobs, null)).toBe(0);
  });

  it('the Infra plans row and the badge count it, with its line, and mark it high', () => {
    const rows = needsYouRows(counts({ plans: 1, plansHigh: 1, planLines: planWaitingLines(view, now) }));
    expect(rows.find((r) => r.kind === 'plans')).toMatchObject({ n: 1, high: 1, href: '#infra', details: [expect.stringContaining('plan cc564657')] });
    expect(needsYouTotal(rows)).toEqual({ n: 1, high: 1 });
    expect(needsYouRows(counts({})).find((r) => r.kind === 'plans')).not.toHaveProperty('details');
  });

  it('a job that waits on the plan links to it on Infra, picked, in one click', () => {
    expect(planHref(ID)).toBe(`#infra/${ID}`);
    expect(waitOnLinkOf({ kind: 'plan', planId: ID }, 'o/r')).toEqual({ label: 'approval of infra plan cc564657', href: `#infra/${ID}` });
  });
});
