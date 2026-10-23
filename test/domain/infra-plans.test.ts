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
//
// Feature: approval by risk (part 3)
//   Scenario: a low-risk plan in uat only: an operator approves it, or the hopper when auto-approve is on
//   Scenario: prod, IAM, destroys, data, a diff the hopper cannot read, or any other environment: only an admin
//   Scenario: a plan that failed a check: nobody
//
// Feature: a plan names the read credential it was made with (part 5)
//   Scenario: a plan that names no read credential is kept
//   Scenario: a plan's read credential must be one the vault minted for its job
//
// Feature: Argo CD syncs through the plan gate (issue #959)
//   Scenario: a sync of an Argo CD app is minted a token for hopper-sync in the argocd namespace of its cluster
//   Scenario: an Argo CD app takes sync only, and names its cluster
//   Scenario: a plan for an Argo CD app is a GitOps plan
//   Scenario: a sync of an Argo CD app with no plan, or with a plan of another app, is refused
//
// Feature: infra applies off (issue #1722): changes go through the infrastructure repository's CI only
//   Scenario: with infra applies off, write, sync and apply are refused, plan or not, and the refusal names CI; a read is let through
import { describe, expect, it } from 'vitest';
import { applyRefusal, appliesRefusal, approveRefusal, approverOf, headRefusal, planInputProblem, readProfileOf, readRefusal, PLAN_JSON_MAX, PLAN_TEXT_MAX, type InfraPlan, type PlanInput } from '../../src/domain/infra-plans.ts';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { PlanSummary } from '../../src/domain/infra-plan-summary.ts';
import { mintTarget } from '../../src/domain/minting.ts';

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

describe('approval by risk', () => {
  const summary = (o: Partial<PlanSummary>): PlanSummary => ({
    words: 'Adds 1 security group rule in uat', level: 'low', counts: { create: 1, update: 0, replace: 0, delete: 0 }, environments: ['uat'],
    risks: [], blastRadius: '', checks: [], failed: false, ...o,
  });
  const callout = (risk: PlanSummary['risks'][number]['risk']) => ({ risk, words: risk, resources: ['x'] });

  it('lets an operator approve a low-risk plan in uat only', () => {
    expect(approverOf({ summary: summary({}) })).toEqual({ who: 'operator', why: 'low risk, in uat only' });
    expect(approverOf({ summary: summary({ risks: [callout('network')] }) })).toEqual({ who: 'operator', why: 'low risk, in uat only' });
    expect(approveRefusal({ ...plan, summary: summary({}) }, 'operator')).toBeUndefined();
    expect(approveRefusal({ ...plan, summary: summary({}) }, 'admin')).toBeUndefined();
    expect(approveRefusal({ ...plan, summary: summary({}) }, 'viewer')).toMatch(/an operator or an admin approves it/);
  });

  it('leaves prod, IAM, destroys, data and a diff it cannot read to an admin, and says why', () => {
    const high = summary({ level: 'high', environments: ['prod'], risks: [callout('destroy'), callout('iam'), callout('prod'), callout('network')] });
    expect(approverOf({ summary: high })).toEqual({ who: 'admin', why: 'high risk: destroys, IAM and identity, prod' });
    expect(approverOf({ summary: summary({ level: 'high', risks: [callout('data')] }) })).toEqual({ who: 'admin', why: 'high risk: data' });
    expect(approverOf({ summary: summary({ level: 'high', environments: [] }) })).toEqual({ who: 'admin', why: 'high risk: the hopper found no change it knows in the diff' });
    expect(approveRefusal({ ...plan, summary: high }, 'operator')).toBe(`plan ${plan.id} is high risk: destroys, IAM and identity, prod: only an admin approves it`);
    expect(approveRefusal({ ...plan, summary: high }, 'admin')).toBeUndefined();
  });

  it('leaves a low-risk plan outside uat, or in uat and another environment, to an admin', () => {
    expect(approverOf({ summary: summary({ environments: ['dev'] }) })).toEqual({ who: 'admin', why: 'low risk, but not in uat only: in dev' });
    expect(approverOf({ summary: summary({ environments: ['uat', 'staging'] }) })).toEqual({ who: 'admin', why: 'low risk, but not in uat only: in uat, staging' });
    expect(approverOf({ summary: summary({ environments: [] }) })).toEqual({ who: 'admin', why: 'low risk, but not in uat only: environment not named' });
  });

  it('leaves a plan kept before summaries to an admin, and a failed plan to nobody', () => {
    expect(approverOf({})).toEqual({ who: 'admin', why: 'it was kept before plans had a summary' });
    const check = { name: 'map-tag' as const, ok: false, words: '1 new AWS resource lacks the MAP tag' };
    const failed = summary({ level: 'high', checks: [check], failed: true });
    expect(approverOf({ summary: failed })).toEqual({ who: 'nobody', why: 'it failed its checks: 1 new AWS resource lacks the MAP tag' });
    expect(approveRefusal({ ...plan, summary: failed }, 'admin')).toBe(`plan ${plan.id} failed its checks, so nobody approves it: 1 new AWS resource lacks the MAP tag`);
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

describe('a plan\'s read credential (part 5)', () => {
  const minted = [readProfileOf(ROLE), readProfileOf({ kind: 'cluster', name: 'utility' })];

  it('is the profile of a read the vault minted, as a plan names it', () => {
    expect(minted).toEqual(['read/aws-role/123456789012/deploy', 'read/cluster/utility']);
  });

  it('may be left out: the plan names no read credential', () => {
    expect(readRefusal(undefined, [])).toBeUndefined();
  });

  it('must be a read the vault minted for the plan\'s job', () => {
    expect(readRefusal('read/aws-role/123456789012/deploy', minted)).toBeUndefined();
    expect(readRefusal('read/aws-role/123456789012/other', minted))
      .toBe('read names read/aws-role/123456789012/other, but the vault minted this job no such read credential (it minted read/aws-role/123456789012/deploy, read/cluster/utility): a plan names the read credential it was made with');
    expect(readRefusal('read/cluster/utility', [])).toMatch(/minted this job no such read credential \(it minted none\)/);
  });
});

describe('Argo CD syncs through the plan gate (issue #959)', () => {
  const WEB = { kind: 'argocd-app', name: 'lab/web' } as const;
  const sync: OperationProfile = { operation: 'sync', asset: WEB };

  it('mints a sync of an Argo CD app a token for hopper-sync in the argocd namespace of its cluster', () => {
    expect(mintTarget('kube', sync)).toEqual({ kind: 'kube', mintsFor: { kind: 'cluster', name: 'lab' }, namespace: 'argocd', serviceAccount: 'hopper-sync', expirationSeconds: 600 });
  });

  it('takes sync only on an Argo CD app, and needs its cluster', () => {
    for (const operation of ['read', 'write', 'apply'] as const) {
      expect(mintTarget('kube', { operation, asset: WEB })).toMatch(/^an argocd-app takes sync only/);
    }
    expect(mintTarget('kube', { operation: 'sync', asset: { kind: 'argocd-app', name: 'web' } })).toMatch(/argocd-app\/<cluster>\/<app>/);
    expect(mintTarget('aws', sync)).toMatch(/^an aws credential is minted for an aws-role/);
  });

  it('keeps a plan for an Argo CD app only when it is a GitOps plan', () => {
    const input: PlanInput = { tool: 'gitops', asset: WEB, target: 'argocd app web', repo: 'octo/deploy', ref: 'issue-2', commit: COMMIT, text: '===== apps/Deployment web/web ======' };
    expect(planInputProblem(input)).toBeUndefined();
    for (const tool of ['terraform', 'helm'] as const) expect(planInputProblem({ ...input, tool })).toMatch(/^a plan for an argocd-app is a gitops plan/);
  });

  it('refuses a sync with no plan, and with a plan of another app; lets a current approved plan of the app through', () => {
    const now = at('2026-10-12T10:10:00Z');
    expect(applyRefusal(sync, undefined, undefined, undefined, now)).toMatch(/^no apply without a plan: sync on argocd-app lab\/web changes infrastructure/);
    const gitops: InfraPlan = { ...plan, tool: 'gitops', asset: { kind: 'argocd-app', name: 'lab/shop' } };
    expect(applyRefusal(sync, plan.id, gitops, approval, now)).toMatch(/is a plan for argocd-app lab\/shop, not argocd-app lab\/web/);
    expect(applyRefusal(sync, plan.id, { ...gitops, asset: WEB }, approval, now)).toBeUndefined();
  });
});

describe('infra applies off (issue #1722)', () => {
  it('refuses write, sync and apply, and says that changes go through CI; lets a read through', () => {
    expect(appliesRefusal({ operation: 'read', asset: ROLE }, false)).toBeUndefined();
    for (const operation of ['write', 'sync', 'apply'] as const) {
      expect(appliesRefusal({ operation, asset: ROLE }, false)).toMatch(/^infra applies are off on this hopper: it mints no credential for .* on aws-role 123456789012\/deploy\. An infrastructure change goes through CI/);
    }
    expect(appliesRefusal(apply, true)).toBeUndefined();
  });
});
