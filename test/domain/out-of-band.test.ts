// Issue #871: out-of-band changes. One generic rule, no per-action classifier: a write is out of band unless a GitOps
// controller or a plan-bound apply credential made it; drift is out of band by itself (design.md "Out-of-band changes").
//
// Feature: an infrastructure change that did not come through IaC or GitOps is tracked
//   Scenario: drift (a GitOps app out of sync, a non-empty terraform plan on unchanged code) is out of band
//   Scenario: an audit-log write by a controller identity is in band; a pattern names a group of them
//   Scenario: an audit-log write by a plan-bound apply credential, while it was valid, is in band, and names the plan
//   Scenario: any other audit-log write is out of band, whatever the action
//   Scenario: a signal that is not whole is refused, with why
//   Scenario: a mint's principal is what an audit log names it as
import { describe, expect, it } from 'vitest';
import {
  controllerProblem, judge, markProblem, mintPrincipal, signalProblem, type ApplyIdentity, type Signal,
} from '../../src/domain/out-of-band.ts';

const AT = '2026-10-12T10:05:00.000Z';
const trail: Signal = {
  source: 'cloudtrail', key: 'evt-1', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress', at: AT,
  who: 'arn:aws:sts::123456789012:assumed-role/Admin/someone',
};
const apply: ApplyIdentity = {
  principal: 'arn:aws:sts::123456789012:assumed-role/deploy/hopper-j1', plan: '11111111-2222-4333-8444-555555555555', job: 'j1',
  from: '2026-10-12T10:00:00.000Z', until: '2026-10-12T10:15:00.000Z',
};

describe('the out-of-band rule', () => {
  it('holds drift out of band by itself: nothing in git made it', () => {
    const drift: Signal = { source: 'gitops', key: 'web', target: 'argocd app web', what: 'OutOfSync', at: AT };
    expect(judge(drift, [], [])).toEqual({ outOfBand: true });
    expect(judge({ ...drift, source: 'terraform-plan', target: 'uat-network', what: '1 to change' }, ['*'], [apply])).toEqual({ outOfBand: true });
  });

  it('holds a write by a controller identity in band; a trailing * names a group', () => {
    const argo = { ...trail, source: 'kube-audit', who: 'system:serviceaccount:argocd:argocd-application-controller' } as const;
    expect(judge(argo, ['system:serviceaccount:argocd:argocd-application-controller'], [])).toEqual({ outOfBand: false, why: 'controller system:serviceaccount:argocd:argocd-application-controller' });
    expect(judge(argo, ['system:serviceaccount:argocd:*'], [])).toEqual({ outOfBand: false, why: 'controller system:serviceaccount:argocd:*' });
    expect(judge(argo, ['system:serviceaccount:flux-system:*'], [])).toEqual({ outOfBand: true });
  });

  it('holds a write by a plan-bound apply credential in band while it was valid, and names the plan', () => {
    const byApply = { ...trail, who: apply.principal };
    expect(judge(byApply, [], [apply])).toEqual({ outOfBand: false, why: `apply of plan ${apply.plan} by job j1` });
    expect(judge({ ...byApply, at: '2026-10-12T10:20:00.000Z' }, [], [apply])).toEqual({ outOfBand: true });
    expect(judge({ ...byApply, at: '2026-10-12T09:59:00.000Z' }, [], [apply])).toEqual({ outOfBand: true });
  });

  it('holds every other write out of band, whatever the action', () => {
    expect(judge(trail, ['system:serviceaccount:argocd:*'], [apply])).toEqual({ outOfBand: true });
    expect(judge({ ...trail, what: 'iam:CreateUser' }, [], [])).toEqual({ outOfBand: true });
  });
});

describe('what a signal must say', () => {
  it('takes a whole signal', () => {
    expect(signalProblem(trail)).toBeUndefined();
    expect(signalProblem({ source: 'gitops', key: 'web', target: 'argocd app web', what: 'OutOfSync', at: AT })).toBeUndefined();
  });

  it('refuses one that is not whole, with why', () => {
    expect(signalProblem({ ...trail, source: 'jira' as Signal['source'] })).toMatch(/^source must be one of gitops, terraform-plan, cloudtrail, kube-audit/);
    const { who: _who, ...nobody } = trail;
    expect(signalProblem(nobody)).toMatch(/^who must name the principal/);
    expect(signalProblem({ ...trail, target: 'two\nlines' })).toMatch(/^target must be one line/);
    expect(signalProblem({ ...trail, what: '' })).toMatch(/^what must be one line/);
    expect(signalProblem({ ...trail, key: '' })).toMatch(/^key must be/);
    expect(signalProblem({ ...trail, at: 'yesterday' })).toMatch(/^at must be/);
    expect(signalProblem({ ...trail, detail: 'x'.repeat(64 * 1024 + 1) })).toMatch(/^detail must be at most/);
  });

  it('takes controller identities as one line each, a * only at the end', () => {
    expect(controllerProblem(['system:serviceaccount:argocd:*', 'arn:aws:sts::123456789012:assumed-role/atlantis/*'])).toBeUndefined();
    expect(controllerProblem(['*'])).toMatch(/names every principal/);
    expect(controllerProblem(['a*b'])).toMatch(/only at the end/);
    expect(controllerProblem([''])).toMatch(/one line/);
  });

  it('takes a mark: adopted or reverted, or accepted with a reason', () => {
    expect(markProblem('adopted', undefined)).toBeUndefined();
    expect(markProblem('reverted', 'rolled back by hand')).toBeUndefined();
    expect(markProblem('accepted', 'break-glass fix during the outage')).toBeUndefined();
    expect(markProblem('accepted', ' ')).toMatch(/^accepted needs a reason/);
    expect(markProblem('ignored' as 'adopted', undefined)).toMatch(/^mark must be one of adopted, reverted, accepted/);
  });
});

describe('the principal of a mint', () => {
  it('is the assumed role session for AWS, without the role path, in the role\'s partition', () => {
    expect(mintPrincipal({ kind: 'aws', roleArn: 'arn:aws:iam::123456789012:role/deploy', sessionName: 'hopper-j1' })).toBe('arn:aws:sts::123456789012:assumed-role/deploy/hopper-j1');
    expect(mintPrincipal({ kind: 'aws', roleArn: 'arn:aws-us-gov:iam::123456789012:role/team/deploy', sessionName: 's' })).toBe('arn:aws-us-gov:sts::123456789012:assumed-role/deploy/s');
  });

  it('is the service account for a Kubernetes token', () => {
    expect(mintPrincipal({ kind: 'kube', namespace: 'web', serviceAccount: 'hopper-apply' })).toBe('system:serviceaccount:web:hopper-apply');
  });
});
