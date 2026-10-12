// Issue #870: no apply without a plan. The gate the vault asks before it mints a credential that can change
// infrastructure, and what a job's plan must say to be kept (design.md "Infra plans: no apply without a plan").
//
// Feature: a credential that changes infrastructure is minted only for a current, approved plan
//   Scenario: a read needs no plan
//   Scenario: any other operation without a plan is refused, and says how to get one
//   Scenario: a plan of another asset, a stale plan, an unapproved plan are refused
//   Scenario: a plan that failed a check (the MAP tag) is refused, approved or not
//   Scenario: a plan made at another commit than the branch's head now is refused: plan again
//   Scenario: a plan input that is not whole is refused, with why
import { describe, expect, it } from 'vitest';
import { applyRefusal, headRefusal, planInputProblem, PLAN_JSON_MAX, PLAN_TEXT_MAX, type InfraPlan, type PlanInput } from '../../src/domain/infra-plans.ts';
import type { OperationProfile } from '../../src/domain/access.ts';

const COMMIT = 'a'.repeat(40);
const ROLE = { kind: 'aws-role', name: '123456789012/deploy' } as const;
const apply: OperationProfile = { operation: 'apply', asset: ROLE };
const plan: InfraPlan = {
  id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: ROLE, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1',
  commit: COMMIT, text: 'Plan: 2 to add, 0 to change, 0 to destroy.', job: 'j1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
};
const approval = { plan: plan.id, by: 'admin', at: '2026-10-12T10:05:00.000Z' };
const at = (iso: string) => new Date(iso);

describe('the apply gate', () => {
  it('lets a read through with no plan', () => {
    expect(applyRefusal({ operation: 'read', asset: ROLE }, undefined, undefined, undefined, at('2026-10-12T10:10:00Z'))).toBeUndefined();
  });

  it('refuses write, sync and apply with no plan, and says how to get one', () => {
    for (const operation of ['write', 'sync', 'apply'] as const) {
      expect(applyRefusal({ operation, asset: ROLE }, undefined, undefined, undefined, at('2026-10-12T10:10:00Z'))).toMatch(/^no apply without a plan: .*POST \/job\/infra-plans.*--plan <id>/);
    }
    expect(applyRefusal(apply, plan.id, undefined, undefined, at('2026-10-12T10:10:00Z'))).toMatch(/^no plan 1111/);
  });

  it('refuses a plan of another asset, a stale plan and an unapproved plan; lets a current approved one through', () => {
    const now = at('2026-10-12T10:10:00Z');
    expect(applyRefusal({ operation: 'apply', asset: { kind: 'aws-role', name: '123456789012/other' } }, plan.id, plan, approval, now)).toMatch(/is a plan for aws-role 123456789012\/deploy/);
    expect(applyRefusal(apply, plan.id, plan, approval, at('2026-10-12T11:00:00Z'))).toMatch(/is stale.*Plan again/);
    expect(applyRefusal(apply, plan.id, plan, undefined, now)).toMatch(/is not approved/);
    expect(applyRefusal(apply, plan.id, plan, approval, now)).toBeUndefined();
  });

  it('refuses a plan that failed a check, approved or not', () => {
    const now = at('2026-10-12T10:10:00Z');
    const check = { name: 'map-tag' as const, ok: false, words: '1 new AWS resource lacks the MAP tag', resources: ['aws_instance.a'] };
    const failed: InfraPlan = { ...plan, summary: { words: 'Adds 1 instance', level: 'high', counts: { create: 1, update: 0, replace: 0, delete: 0 }, environments: [], risks: [], blastRadius: '', checks: [check], failed: true } };
    expect(applyRefusal(apply, plan.id, failed, approval, now)).toMatch(/failed its checks: 1 new AWS resource lacks the MAP tag\. Fix the code and plan again$/);
  });

  it('refuses a plan made at another commit than the head now', () => {
    expect(headRefusal(plan, COMMIT)).toBeUndefined();
    expect(headRefusal(plan, 'b'.repeat(40))).toMatch(/^the code moved since plan .*octo\/infra issue-1 is at bbbbbbbbbbbb now, the plan was made at aaaaaaaaaaaa\. Plan again$/);
  });
});

describe('a plan input', () => {
  const input: PlanInput = { tool: 'terraform', asset: ROLE, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1', commit: COMMIT, text: 'Plan: 1 to add.' };

  it('is kept when whole', () => {
    expect(planInputProblem(input)).toBeUndefined();
    expect(planInputProblem({ ...input, pullRequest: 4, read: 'read/aws-role/123456789012/ReadOnly' })).toBeUndefined();
  });

  it('is refused with why when it is not', () => {
    expect(planInputProblem({ ...input, tool: 'pulumi' as never })).toMatch(/^tool must be/);
    expect(planInputProblem({ ...input, asset: { kind: 'aws-role', name: 'a b' } })).toMatch(/asset name/);
    expect(planInputProblem({ ...input, repo: 'nope' })).toMatch(/^repo/);
    expect(planInputProblem({ ...input, ref: 'a..b' })).toMatch(/^ref/);
    expect(planInputProblem({ ...input, commit: 'abc' })).toMatch(/^commit/);
    expect(planInputProblem({ ...input, read: 'write/aws-role/x' })).toMatch(/^read/);
    expect(planInputProblem({ ...input, text: ' ' })).toMatch(/^text must hold/);
    expect(planInputProblem({ ...input, text: 'x'.repeat(PLAN_TEXT_MAX + 1) })).toMatch(/at most/);
    expect(planInputProblem({ ...input, json: 'x'.repeat(PLAN_JSON_MAX + 1) })).toMatch(/^json must be at most/);
  });
});
