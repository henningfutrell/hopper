// Infra changes in the UI (ui/src/model/infra-plans.ts, issue #870), pure: each plan in one line — what changes where,
// from which commit — and its state: waiting for a person, approved and still current, or stale.
import { describe, expect, it } from 'vitest';
import { planHeadline, planState } from '../../ui/src/model/infra-plans.ts';
import type { PlanView } from '../../src/domain/types.ts';

const plan: PlanView = {
  id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network',
  repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), pullRequest: 4, job: 'j1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
};
const now = Date.parse('2026-10-12T10:30:00.000Z');

describe('the Infra changes model', () => {
  it('says what a plan changes, where, and from which commit', () => {
    expect(planHeadline(plan)).toBe('terraform: uat-network, applied as aws-role 123456789012/deploy, from octo/infra issue-1 at aaaaaaaaaaaa (pull request 4)');
    const { pullRequest: _pr, ...noPr } = plan;
    expect(planHeadline(noPr)).toBe('terraform: uat-network, applied as aws-role 123456789012/deploy, from octo/infra issue-1 at aaaaaaaaaaaa');
  });

  it('a plan waits for a person, is approved, or is stale: then nothing applies it', () => {
    expect(planState(plan, now)).toEqual({ kind: 'waiting', words: 'Waits for approval: stale in 30 min' });
    expect(planState({ ...plan, approval: { plan: plan.id, by: 'Ada', at: '2026-10-12T10:05:00.000Z' } }, now)).toEqual({ kind: 'approved', words: 'Approved by Ada: stale in 30 min' });
    expect(planState(plan, Date.parse(plan.expiresAt))).toEqual({ kind: 'stale', words: 'Stale: the job plans again' });
  });
});
