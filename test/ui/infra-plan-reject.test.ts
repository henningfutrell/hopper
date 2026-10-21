// Issue #2368: Infra in the UI, pure: a rejected plan says who rejected it and why, whatever its age; it waits for nobody,
// is offered no Approve, and is offered no Reject. A plan that waits is offered Reject to an operator or an admin.
import { describe, expect, it } from 'vitest';
import { planApprove, planReject, planState, plansWaiting } from '../../ui/src/model/infra-plans.ts';
import type { PlanView } from '../../src/domain/types.ts';

const plan: PlanView = {
  id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'prod-identity',
  repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), job: 'j1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
  approver: { who: 'admin', why: 'high risk: prod' },
};
const now = Date.parse('2026-10-12T10:30:00.000Z');
const rejected: PlanView = { ...plan, rejection: { plan: plan.id, by: 'Ada', at: '2026-10-12T10:10:00.000Z', note: 'Keep the statefulset' } };
const admin = { operate: true, admin: true };

describe('a rejected infra plan in the UI (issue #2368)', () => {
  it('says who rejected it and why, also once it would be stale', () => {
    expect(planState(rejected, now)).toEqual({ kind: 'rejected', words: 'Rejected by Ada: Keep the statefulset. Nobody approves it' });
    expect(planState(rejected, Date.parse(plan.expiresAt) + 1)).toMatchObject({ kind: 'rejected' });
  });

  it('waits for nobody, and is offered neither Approve nor Reject', () => {
    expect(plansWaiting({ plans: [rejected, plan] }, now)).toBe(1);
    expect(planApprove(rejected, now, admin)).toEqual({ show: false });
    expect(planReject(rejected, now, admin)).toBe(false);
  });

  it('a plan that waits is offered Reject to an operator or an admin, never to a viewer', () => {
    expect(planReject(plan, now, admin)).toBe(true);
    expect(planReject(plan, now, { operate: true })).toBe(true);
    expect(planReject(plan, now, { operate: false })).toBe(false);
    expect(planReject({ ...plan, approval: { plan: plan.id, by: 'Ada', at: '2026-10-12T10:05:00.000Z' } }, now, admin)).toBe(false);
  });
});
