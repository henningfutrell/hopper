// Issue #871 part 3: the ready-made collector's pure half. It turns what the read-only tools print — Argo CD's and Flux's
// objects, `terraform plan -detailed-exitcode`, CloudTrail's lookup-events, the Kubernetes audit log — into signals, and
// classifies no action: the hopper's rule judges each one (design.md "Out-of-band changes", part 3).
//
// Feature: the collector reports what the tools found, as signals the hopper keeps
//   Scenario: an Argo CD application out of sync is drift; one in sync is nothing
//   Scenario: a Flux object that is not ready, or is suspended, is drift
//   Scenario: a terraform plan that is not empty (exit code 2) is drift; an empty one is nothing; a failed one says why
//   Scenario: each CloudTrail write is a signal with its principal; a read is none
//   Scenario: each Kubernetes audit write that went through is a signal with its user; a read, a refusal, an older one is none
//   Scenario: every signal is one the hopper takes whole, however long the source's text
import { describe, expect, it } from 'vitest';
import {
  ARGO_PLAN_GATE_LABEL, argoSignals, cloudTrailSignals, fluxSignals, kubeAuditSignals, terraformSignal,
} from '../../src/domain/out-of-band-collect.ts';
import { DETAIL_MAX, signalProblem } from '../../src/domain/out-of-band.ts';

const NOW = '2026-10-12T12:00:00.000Z';
const SINCE = '2026-10-12T11:00:00.000Z';

describe('Argo CD', () => {
  it('reports an application out of sync, with its out-of-sync resources; one in sync is nothing', () => {
    const list = {
      items: [
        {
          metadata: { namespace: 'argocd', name: 'web' },
          status: {
            sync: { status: 'OutOfSync', revision: 'abc123' },
            resources: [
              { kind: 'Deployment', namespace: 'web', name: 'web', status: 'OutOfSync' },
              { kind: 'Service', namespace: 'web', name: 'web', status: 'Synced' },
            ],
          },
        },
        { metadata: { namespace: 'argocd', name: 'api' }, status: { sync: { status: 'Synced' } } },
      ],
    };
    const s = argoSignals(list, NOW);
    expect(s).toEqual([{
      source: 'gitops', key: 'argocd:argocd/web', target: 'Argo CD application argocd/web', what: 'OutOfSync', at: NOW,
      detail: 'revision abc123\nDeployment web/web OutOfSync',
    }]);
    expect(signalProblem(s[0]!)).toBeUndefined();
  });

  it('reports a gated application (issue #959) that syncs by itself: its syncs never ask for a plan', () => {
    const gated = { [ARGO_PLAN_GATE_LABEL]: 'true' };
    const list = {
      items: [
        { metadata: { namespace: 'argocd', name: 'web', labels: gated }, spec: { syncPolicy: { automated: { prune: true } } }, status: { sync: { status: 'Synced' } } },
        { metadata: { namespace: 'argocd', name: 'shop', labels: gated }, spec: { syncPolicy: {} }, status: { sync: { status: 'Synced' } } },
        { metadata: { namespace: 'argocd', name: 'docs' }, spec: { syncPolicy: { automated: {} } }, status: { sync: { status: 'Synced' } } },
      ],
    };
    const s = argoSignals(list, NOW);
    expect(s).toEqual([{
      source: 'gitops', key: 'argocd:argocd/web:auto-sync', target: 'Argo CD application argocd/web', what: 'AutoSyncOnGatedApp', at: NOW,
      detail: `the application is labelled ${ARGO_PLAN_GATE_LABEL}=true, but Argo CD syncs it by itself: turn off its automated sync, so it syncs only through an approved plan`,
    }]);
    expect(signalProblem(s[0]!)).toBeUndefined();
  });
});

describe('Flux', () => {
  it('reports an object that is not ready, or is suspended, by its reason; a ready one is nothing', () => {
    const list = {
      items: [
        {
          kind: 'Kustomization', metadata: { namespace: 'flux-system', name: 'apps' },
          status: { conditions: [{ type: 'Ready', status: 'False', reason: 'ReconciliationFailed', message: 'apply failed' }] },
        },
        { kind: 'HelmRelease', metadata: { namespace: 'web', name: 'redis' }, spec: { suspend: true }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        { kind: 'HelmRelease', metadata: { namespace: 'web', name: 'nginx' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      ],
    };
    expect(fluxSignals(list, NOW)).toEqual([
      { source: 'gitops', key: 'flux:Kustomization/flux-system/apps', target: 'Flux Kustomization flux-system/apps', what: 'ReconciliationFailed', at: NOW, detail: 'apply failed' },
      { source: 'gitops', key: 'flux:HelmRelease/web/redis', target: 'Flux HelmRelease web/redis', what: 'Suspended', at: NOW },
    ]);
  });
});

describe('terraform plan', () => {
  const text = 'Terraform will perform the following actions:\n  # aws_security_group.web will be updated in-place\n\nPlan: 0 to add, 1 to change, 0 to destroy.\n';

  it('reports a plan that is not empty (exit code 2) with its summary and its text', () => {
    expect(terraformSignal('infra/network', 2, text, NOW)).toEqual({
      source: 'terraform-plan', key: 'terraform:infra/network', target: 'terraform infra/network',
      what: 'Plan: 0 to add, 1 to change, 0 to destroy.', at: NOW, detail: text,
    });
  });

  it('reports nothing for an empty plan, and throws for a failed one, with its text', () => {
    expect(terraformSignal('infra/network', 0, 'No changes.', NOW)).toBeUndefined();
    expect(() => terraformSignal('infra/network', 1, 'Error: no credentials', NOW)).toThrow(/infra\/network.*Error: no credentials/s);
  });
});

describe('CloudTrail', () => {
  it('reports each write with the principal that made it, and none for a read', () => {
    const record = { eventID: 'e-1', readOnly: false, userIdentity: { arn: 'arn:aws:sts::123456789012:assumed-role/Admin/someone' } };
    const out = {
      Events: [
        {
          EventId: 'e-1', EventName: 'AuthorizeSecurityGroupIngress', EventSource: 'ec2.amazonaws.com', EventTime: '2026-10-12T11:30:00+00:00',
          ReadOnly: 'false', Username: 'someone', Resources: [{ ResourceType: 'AWS::EC2::SecurityGroup', ResourceName: 'sg-0abc' }],
          CloudTrailEvent: JSON.stringify(record),
        },
        { EventId: 'e-2', EventName: 'DescribeInstances', EventSource: 'ec2.amazonaws.com', EventTime: '2026-10-12T11:31:00+00:00', ReadOnly: 'true', CloudTrailEvent: '{}' },
      ],
    };
    expect(cloudTrailSignals(out)).toEqual([{
      source: 'cloudtrail', key: 'e-1', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress', at: '2026-10-12T11:30:00+00:00',
      who: 'arn:aws:sts::123456789012:assumed-role/Admin/someone', detail: JSON.stringify(record),
    }]);
  });

  it('names the user name when the record has no ARN, and the event source when there is no resource', () => {
    const [s] = cloudTrailSignals({ Events: [{ EventId: 'e-3', EventName: 'PutBucketPolicy', EventSource: 's3.amazonaws.com', EventTime: '2026-10-12T11:30:00+00:00', Username: 'root', CloudTrailEvent: '{"readOnly":false}' }] });
    expect(s).toMatchObject({ who: 'root', target: 's3.amazonaws.com', what: 's3:PutBucketPolicy' });
  });
});

describe('the Kubernetes audit log', () => {
  const event = (o: Record<string, unknown>) => JSON.stringify({
    kind: 'Event', apiVersion: 'audit.k8s.io/v1', auditID: 'a-1', stage: 'ResponseComplete', verb: 'patch',
    user: { username: 'alice@example.com' }, objectRef: { resource: 'deployments', namespace: 'web', name: 'web', apiGroup: 'apps' },
    responseStatus: { code: 200 }, requestReceivedTimestamp: '2026-10-12T11:30:00.000000Z', stageTimestamp: '2026-10-12T11:30:00.100000Z', ...o,
  });

  it('reports each write that went through, after the time given, with its user', () => {
    const lines = [
      event({}),
      event({ auditID: 'a-2', verb: 'get' }),
      event({ auditID: 'a-3', responseStatus: { code: 403 } }),
      event({ auditID: 'a-4', stage: 'RequestReceived' }),
      event({ auditID: 'a-5', requestReceivedTimestamp: '2026-10-12T10:00:00Z', stageTimestamp: '2026-10-12T10:00:00Z' }),
      event({ auditID: 'a-6', verb: 'create', objectRef: { resource: 'pods', subresource: 'exec', namespace: 'web', name: 'web-1' } }),
      'not json',
      '',
    ].join('\n');
    const { signals, skipped } = kubeAuditSignals(lines, SINCE);
    expect(signals).toEqual([
      { source: 'kube-audit', key: 'a-1', target: 'web/deployments/web', what: 'patch deployments', who: 'alice@example.com', at: '2026-10-12T11:30:00.100000Z', detail: event({}) },
      expect.objectContaining({ key: 'a-6', target: 'web/pods/web-1', what: 'create pods/exec' }),
    ]);
    expect(skipped).toBe(1);
    for (const s of signals) expect(signalProblem(s)).toBeUndefined();
  });
});

describe('every signal is whole', () => {
  it('keeps text one line and in its limits, however long the source gives it', () => {
    const huge = 'x'.repeat(DETAIL_MAX * 2);
    const s = terraformSignal(`infra/${'n'.repeat(400)}`, 2, `${huge}\nPlan: 1 to add, 0 to change, 0 to destroy.\n`, NOW)!;
    expect(signalProblem(s)).toBeUndefined();
    expect(s.detail!.endsWith('Plan: 1 to add, 0 to change, 0 to destroy.\n')).toBe(true);
    const [a] = argoSignals({ items: [{ metadata: { namespace: 'n', name: 'a\nb' }, status: { sync: { status: 'OutOfSync' } } }] }, NOW);
    expect(signalProblem(a!)).toBeUndefined();
  });
});
