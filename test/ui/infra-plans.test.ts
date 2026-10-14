// Infra in the UI (ui/src/model/infra-plans.ts, issue #870), pure: each plan in one line — what changes where,
// from which commit — its state: waiting for a person, approved and still current, stale, or failed a check — and its
// explainer.
import { describe, expect, it } from 'vitest';
import { applyLine, askedLine, infraTimeline, planApprove, planExplainer, planHeadline, planState, watchersFrom, watchersText } from '../../ui/src/model/infra-plans.ts';
import type { OutOfBandView, PlanApply, PlanSummary, PlanView } from '../../src/domain/types.ts';

const plan: PlanView = {
  id: '11111111-2222-4333-8444-555555555555', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network',
  repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), pullRequest: 4, job: 'j1', createdAt: '2026-10-12T10:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z',
  approver: { who: 'operator', why: 'low risk, in uat only' },
};
const now = Date.parse('2026-10-12T10:30:00.000Z');
const summary: PlanSummary = {
  words: 'Adds 2 security group rules in uat; changes nothing in prod; destroys nothing', level: 'low', counts: { create: 2, update: 0, replace: 0, delete: 0 }, environments: ['uat'],
  risks: [{ risk: 'network', words: 'Network: 2 resources: aws_security_group_rule.a, aws_security_group_rule.b', resources: ['aws_security_group_rule.a', 'aws_security_group_rule.b'] }],
  blastRadius: '2 resources of 1 kind, in uat; applied as aws-role 123456789012/deploy to uat-network',
  checks: [{ name: 'map-tag', ok: true, words: 'Every new AWS resource has the MAP tag map-migrated=migXWT2TUR4TJ' }], failed: false,
};

describe('the Infra model', () => {
  it('says what a plan changes, where, and from which commit', () => {
    expect(planHeadline(plan)).toBe('terraform: uat-network, applied as aws-role 123456789012/deploy, from octo/infra issue-1 at aaaaaaaaaaaa (pull request 4)');
    const { pullRequest: _pr, ...noPr } = plan;
    expect(planHeadline(noPr)).toBe('terraform: uat-network, applied as aws-role 123456789012/deploy, from octo/infra issue-1 at aaaaaaaaaaaa');
  });

  it('a plan waits for a person, is approved, or is stale: then nothing applies it', () => {
    expect(planState(plan, now)).toEqual({ kind: 'waiting', words: 'Waits for an operator or an admin to approve it (low risk, in uat only): stale in 30 min' });
    expect(planState({ ...plan, approver: { who: 'admin', why: 'high risk: prod' } }, now)).toEqual({ kind: 'waiting', words: 'Waits for an admin to approve it (high risk: prod): stale in 30 min' });
    expect(planState({ ...plan, approval: { plan: plan.id, by: 'the hopper', at: '2026-10-12T10:00:00.000Z', auto: true } }, now))
      .toEqual({ kind: 'approved', words: 'Approved by the hopper (auto-approve: low risk, in uat only): stale in 30 min' });
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

  it('offers Approve to whom the risk of the plan allows, and asks an admin to confirm a high-risk plan', () => {
    const operator = { operate: true, admin: false };
    const admin = { operate: true, admin: true };
    expect(planApprove(plan, now, operator)).toEqual({ show: true });
    expect(planApprove(plan, now, { operate: false, admin: false })).toEqual({ show: false });
    const prod: PlanView = { ...plan, approver: { who: 'admin', why: 'high risk: prod' }, summary: { ...summary, level: 'high', words: 'Adds 1 instance in prod; destroys nothing' } };
    expect(planApprove(prod, now, operator)).toEqual({ show: false });
    expect(planApprove(prod, now, admin)).toEqual({ show: true, confirm: 'Adds 1 instance in prod; destroys nothing. This plan is high risk: prod. Once you approve it, the vault mints a credential that changes infrastructure for an apply of it, until it is stale.' });
    expect(planApprove({ ...plan, approval: { plan: plan.id, by: 'Ada', at: '2026-10-12T10:05:00.000Z' } }, now, admin)).toEqual({ show: false });
    expect(planApprove({ ...plan, approver: { who: 'nobody', why: 'it failed its checks' } }, now, admin)).toEqual({ show: false });
  });

  it('says each apply: the operation, the asset, the job, and whether it renewed a credential', () => {
    const apply: PlanApply = { plan: plan.id, at: '2026-10-12T10:20:00.000Z', operation: 'apply', asset: plan.asset, job: 'j2abcdefgh', expiresAt: '2026-10-12T10:35:00.000Z', renewal: false };
    expect(applyLine(apply)).toBe('apply on aws-role 123456789012/deploy by job j2abcdef, valid until 2026-10-12T10:35:00.000Z');
    expect(applyLine({ ...apply, renewal: true })).toBe('apply on aws-role 123456789012/deploy by job j2abcdef, valid until 2026-10-12T10:35:00.000Z (renewed)');
  });
});

describe('the applies and drift timeline', () => {
  const apply: PlanApply = { plan: plan.id, at: '2026-10-12T10:20:00.000Z', operation: 'apply', asset: plan.asset, job: 'j1', expiresAt: '2026-10-12T10:35:00.000Z', renewal: false };
  const drift: OutOfBandView = { id: 'c1', source: 'gitops', key: 'web', target: 'argocd app web', what: 'OutOfSync', at: '2026-10-12T10:25:00Z', job: 'j3', recordedAt: '2026-10-12T10:26:00.000Z' };
  const write: OutOfBandView = { id: 'c2', source: 'cloudtrail', key: 'e1', target: 'sg-1', what: 'ec2:AuthorizeSecurityGroupIngress', who: 'arn:aws:sts::1:assumed-role/Admin/x', at: '2026-10-12T09:00:00Z', job: 'j3', recordedAt: '2026-10-12T10:27:00.000Z',
    marked: { change: 'c2', mark: 'reverted', by: 'Ada', at: '2026-10-12T10:40:00.000Z' } };

  it('puts plans, approvals, applies, drift, out-of-band writes and marks in one list, newest first', () => {
    const approved = { ...plan, approval: { plan: plan.id, by: 'Ada', at: '2026-10-12T10:05:00.000Z' } };
    expect(infraTimeline([approved], [apply], [drift, write]).map((e) => [e.kind, e.at])).toEqual([
      ['marked', '2026-10-12T10:40:00.000Z'],
      ['drift', '2026-10-12T10:25:00Z'],
      ['apply', '2026-10-12T10:20:00.000Z'],
      ['approved', '2026-10-12T10:05:00.000Z'],
      ['plan', '2026-10-12T10:00:00.000Z'],
      ['out-of-band', '2026-10-12T09:00:00Z'],
    ]);
  });

  it('says each entry in plain words', () => {
    const words = infraTimeline([plan], [apply], [drift]).map((e) => e.words);
    expect(words).toEqual([
      'GitOps drift: OutOfSync on argocd app web',
      'Applied plan 11111111: apply on aws-role 123456789012/deploy by job j1, valid until 2026-10-12T10:35:00.000Z',
      'Plan 11111111 recorded: terraform: uat-network, applied as aws-role 123456789012/deploy, from octo/infra issue-1 at aaaaaaaaaaaa (pull request 4)',
    ]);
  });

  it('is empty when nothing happened', () => {
    expect(infraTimeline([], [], [])).toEqual([]);
  });
});

describe('an agent\'s ask on a plan (issue #909)', () => {
  it('says who asked through the API, and that approving it here confirms it', () => {
    expect(askedLine({ asker: 'Grok Bot', at: '2026-10-12T10:10:00.000Z' })).toBe('Grok Bot asked to approve this through the API at 2026-10-12T10:10:00.000Z. An API token does not approve a high-risk plan: approve it here to confirm it.');
  });
});

describe('the environment watchers as a person types them (issue #870 part 4)', () => {
  it('reads one environment a line: its name, a colon, the watchers split by commas', () => {
    expect(watchersFrom('prod: prod-owner, ops-lead\n\n * : ops-lead\nuat:qa-team,')).toEqual({ prod: ['prod-owner', 'ops-lead'], '*': ['ops-lead'], uat: ['qa-team'] });
    expect(watchersFrom('')).toEqual({});
  });

  it('says a line it cannot read, so nothing is saved by mistake', () => {
    expect(watchersFrom('prod prod-owner')).toBe('line 1 has no colon: write the environment, a colon, then the watchers');
  });

  it('writes the watchers back as a person types them', () => {
    expect(watchersText({ '*': ['ops-lead'], prod: ['prod-owner', 'ops-lead'] })).toBe('*: ops-lead\nprod: prod-owner, ops-lead');
  });
});
