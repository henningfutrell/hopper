// Infra changes in the UI (ui/src/model/infra-plans.ts, issue #870), pure: each plan in one line — what changes where,
// from which commit — its state: waiting for a person, approved and still current, stale, or failed a check — and its
// explainer.
import { describe, expect, it } from 'vitest';
import { planExplainer, planHeadline, planState } from '../../ui/src/model/infra-plans.ts';
import type { PlanSummary, PlanView } from '../../src/domain/types.ts';

const plan: PlanView = {
  id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network',
  repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), pullRequest: 4, job: 'j1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
};
const now = Date.parse('2026-10-12T10:30:00.000Z');
const summary: PlanSummary = {
  words: 'Adds 2 security group rules in uat; changes nothing in prod; destroys nothing', level: 'low', counts: { create: 2, update: 0, replace: 0, delete: 0 }, environments: ['uat'],
  risks: [{ risk: 'network', words: 'Network: 2 resources: aws_security_group_rule.a, aws_security_group_rule.b', resources: ['aws_security_group_rule.a', 'aws_security_group_rule.b'] }],
  blastRadius: '2 resources of 1 kind, in uat; applied as aws-role 123456789012/deploy to uat-network',
  checks: [{ name: 'map-tag', ok: true, words: 'Every new AWS resource has the MAP tag map-migrated=migXWT2TUR4TJ' }], failed: false,
};

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

  it('a plan that failed a check says so, whatever its approval or age', () => {
    const failed = { ...plan, summary: { ...summary, failed: true, checks: [{ name: 'map-tag' as const, ok: false, words: '1 new AWS resource lacks the MAP tag' }] } };
    expect(planState(failed, now)).toEqual({ kind: 'failed', words: 'Failed its checks: nobody approves it. The job fixes the code and plans again' });
  });

  it('explains a plan: its words, its level, each callout, the blast radius, each check; nothing for a plan kept before', () => {
    expect(planExplainer({ summary })).toEqual({
      words: 'Adds 2 security group rules in uat; changes nothing in prod; destroys nothing', level: 'low',
      lines: ['Network: 2 resources: aws_security_group_rule.a, aws_security_group_rule.b', 'Blast radius: 2 resources of 1 kind, in uat; applied as aws-role 123456789012/deploy to uat-network', 'Passed: Every new AWS resource has the MAP tag map-migrated=migXWT2TUR4TJ'],
    });
    expect(planExplainer({})).toBeUndefined();
  });
});
