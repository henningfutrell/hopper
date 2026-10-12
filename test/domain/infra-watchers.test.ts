// Issue #870 part 4: environment watchers. Who is told of each plan, approval and apply, by the environments the plan
// names (design.md "Infra plans: environment watchers").
//
// Feature: every plan and apply reaches the watchers of its environments
//   Scenario: the watchers of each environment the plan names, and of every environment (`*`), once each
//   Scenario: a plan that names no environment reaches the watchers of every environment only
//   Scenario: a watchers list that is not whole is refused, with why
//   Scenario: a list a person typed is kept trimmed, without empty environments or names named twice
//   Scenario: a plan's notice says what it changes, its risk, who approves it, and who watches it; never its text
import { describe, expect, it } from 'vitest';
import { normalWatchers, planNotice, watchersOf, watchersProblem, WATCHERS_MAX } from '../../src/domain/infra-watchers.ts';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import type { PlanSummary } from '../../src/domain/infra-plan-summary.ts';

const W = { '*': ['ops-lead'], prod: ['prod-owner', 'ops-lead'], uat: ['qa-team'] };

describe('the watchers of a plan', () => {
  it('are the watchers of each environment it names, and of every environment, once each', () => {
    expect(watchersOf(['uat'], W)).toEqual(['ops-lead', 'qa-team']);
    expect(watchersOf(['prod', 'uat'], W)).toEqual(['ops-lead', 'prod-owner', 'qa-team']);
    expect(watchersOf(['staging'], W)).toEqual(['ops-lead']);
  });

  it('are the watchers of every environment only when the plan names none', () => {
    expect(watchersOf([], W)).toEqual(['ops-lead']);
    expect(watchersOf([], {})).toEqual([]);
  });
});

describe('a watchers list', () => {
  it('is kept when whole', () => {
    expect(watchersProblem(W)).toBeUndefined();
    expect(watchersProblem({})).toBeUndefined();
  });

  it('is refused with why when it is not', () => {
    expect(watchersProblem({ production: ['a'] })).toBe('production is not an environment the hopper knows: *, prod, uat, staging, dev, qa');
    expect(watchersProblem({ prod: [''] })).toMatch(/^prod: a watcher is one line of 1 to 100 characters/);
    expect(watchersProblem({ prod: ['a\nb'] })).toMatch(/^prod: a watcher is one line/);
    expect(watchersProblem({ prod: ['x'.repeat(101)] })).toMatch(/^prod: a watcher is one line/);
    expect(watchersProblem({ prod: Array.from({ length: WATCHERS_MAX + 1 }, (_, i) => `w${i}`) })).toMatch(new RegExp(`^prod: at most ${WATCHERS_MAX} watchers`));
  });

  it('is kept trimmed, without empty environments or a name named twice', () => {
    expect(normalWatchers({ prod: [' prod-owner ', 'prod-owner', 'ops-lead'], uat: [] })).toEqual({ prod: ['prod-owner', 'ops-lead'] });
  });
});

describe('the notice of a plan', () => {
  const summary: PlanSummary = {
    words: 'Adds 1 security group rule in uat; changes nothing in prod; destroys nothing', level: 'low',
    counts: { create: 1, update: 0, replace: 0, delete: 0 }, environments: ['uat'], risks: [{ risk: 'network', words: 'network', resources: ['aws_security_group_rule.a'] }],
    blastRadius: '1 resource of 1 kind, in uat; applied as aws-role 123456789012/deploy to uat-network', checks: [], failed: false,
  };
  const plan: InfraPlan = {
    id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network',
    repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), pullRequest: 4, text: 'the raw plan', summary, job: 'j1',
    issue: 'https://github.com/octo/infra/issues/1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
  };

  it('says what the plan changes, its risk, who approves it and who watches it; never its text', () => {
    const notice = planNotice(plan, undefined, W);
    expect(notice).toEqual({
      plan: plan.id, tool: 'terraform', asset: plan.asset, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1', commit: plan.commit, pullRequest: 4,
      issue: plan.issue, words: summary.words, level: 'low', risks: ['network'], environments: ['uat'], blastRadius: summary.blastRadius, failed: false,
      approver: { who: 'operator', why: 'low risk, in uat only' }, watchers: ['ops-lead', 'qa-team'],
    });
    expect(JSON.stringify(notice)).not.toContain('the raw plan');
  });

  it('says who approved it, and that a plan kept before summaries reaches the watchers of every environment', () => {
    const { summary: _s, ...bare } = plan;
    expect(planNotice(bare, { plan: plan.id, by: 'the hopper', at: '2026-10-12T10:01:00.000Z', auto: true }, W)).toMatchObject({
      environments: [], approver: { who: 'admin' }, approval: { by: 'the hopper', at: '2026-10-12T10:01:00.000Z', auto: true }, watchers: ['ops-lead'],
    });
  });
});
