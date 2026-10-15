import { describe, expect, it } from 'vitest';
import { type Container, container, env, find, pod, render, type Resource } from '../support/helm-chart.ts';

// Lane pods (issue #1284, docs/deploy.md "Lane pods on Kubernetes"): a StatefulSet of machines that join the hopper by
// dialling out with the lane pool key, one machine per pod under its pod's name. No sshd, no inbound port.
describe('the Helm chart\'s lane pods', () => {
  const rs = render('lanes.replicas=3');
  const lanes = find(rs, 'StatefulSet', 'hopper-lanes');
  const join = pod(lanes).initContainers?.find((c) => c.name === 'join');
  const lane = container(lanes, 'lane');
  const daemon = container(find(rs, 'Deployment', 'hopper'), 'hopper');
  const mounts = (c: Container | undefined): string[] => (c?.volumeMounts ?? []).map((m) => m.name);

  it('runs none until replicas says so, then one machine per pod', () => {
    expect(find(render(), 'StatefulSet', 'hopper-lanes').spec?.replicas).toBe(0);
    expect(lanes.spec?.replicas).toBe(3);
    expect(lanes.spec?.podManagementPolicy).toBe('Parallel');
  });

  it('runs the sandbox box image of the hopper\'s update channel', () => {
    expect(lane.image).toBe('ghcr.io/henningfutrell/hopper:box-claude');
    expect(join?.image).toBe(lane.image);
    expect(container(find(render('image.tag=stable'), 'StatefulSet', 'hopper-lanes'), 'lane').image).toBe('ghcr.io/henningfutrell/hopper:box-claude');
    expect(container(find(render('image.tag=dev'), 'StatefulSet', 'hopper-lanes'), 'lane').image).toBe('ghcr.io/henningfutrell/hopper:box-claude-dev');
  });

  it('makes the lane pool key at the first install and keeps it, and gives it to the hopper as a file', () => {
    const secret = find(rs, 'Secret', 'hopper-lane-pool');
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(secret.stringData ?? {})).toEqual(['key']);
    expect(secret.stringData?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(env(daemon, 'HOPPER_LANE_POOL_KEY_FILE')?.value).toBe('/run/lane-pool/key');
    const name = daemon.volumeMounts?.find((m) => m.mountPath === '/run/lane-pool')?.name;
    expect(find(rs, 'Deployment', 'hopper').spec?.template?.spec.volumes?.find((v) => v.name === name)?.secret?.secretName).toBe('hopper-lane-pool');
  });

  it('joins each pod under its pod\'s name by dialling out to the hopper\'s Service, and tries again until it is let in', () => {
    expect(env(join as Container, 'POD_NAME')?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.name');
    expect(env(join as Container, 'HOPPER_URL')?.value).toBe('http://hopper:4790');
    const script = join?.command?.join(' ') ?? '';
    expect(script).toContain('join "$HOPPER_URL#$(cat /run/lane-pool/key)" "$POD_NAME"');
    expect(script).toMatch(/until .*; do sleep \d+; done/);
  });

  it('lets only the join step see the lane pool key: never the container the jobs run in', () => {
    const key = pod(lanes).volumes?.find((v) => v.secret?.secretName === 'hopper-lane-pool');
    expect(key).toBeDefined();
    expect(mounts(join)).toContain(key?.name);
    expect(mounts(lane)).not.toContain(key?.name);
    for (const e of lane.env ?? []) expect(e.name).not.toMatch(/LANE_POOL/);
  });

  it('keeps each pod\'s home on a volume of its own, so a restart joins as the same machine', () => {
    expect(lanes.spec?.volumeClaimTemplates?.map((t) => t.metadata.name)).toEqual(['home']);
    expect(lanes.spec?.volumeClaimTemplates?.[0]?.spec.resources.requests.storage).toBe('20Gi');
    expect(lane.volumeMounts?.find((m) => m.name === 'home')?.mountPath).toBe('/home/agent');
    expect(join?.volumeMounts?.find((m) => m.name === 'home')).toBeDefined();
    // A pod scaled away was retired: its volume goes, and a new pod with its name starts as a new machine.
    expect(lanes.spec?.persistentVolumeClaimRetentionPolicy).toEqual({ whenScaled: 'Delete', whenDeleted: 'Retain' });
  });

  it('drains on stop: no new job, and the jobs on it end within the grace period', () => {
    expect(env(lane, 'HOPPER_CLIENT_DRAIN')?.value).toBe('1');
    expect(pod(lanes).terminationGracePeriodSeconds).toBe(3600);
    expect(pod(find(render('lanes.drainSeconds=600'), 'StatefulSet', 'hopper-lanes')).terminationGracePeriodSeconds).toBe(600);
  });

  it('needs no inbound port, no sshd and no Service: nothing reaches a lane pod', () => {
    for (const c of [lane, join as Container]) expect(c.ports ?? []).toEqual([]);
    expect(lane.command).toBeUndefined();
    expect(lane.securityContext?.readOnlyRootFilesystem).toBe(true);
    const selects = (r: Resource): string | undefined => (r.spec?.selector as Record<string, string> | undefined)?.['app.kubernetes.io/component'];
    expect(rs.filter((r) => r.kind === 'Service').map(selects)).not.toContain('lanes');
    const policy = find(rs, 'NetworkPolicy', 'hopper-lanes');
    expect(policy.spec?.podSelector?.matchLabels?.['app.kubernetes.io/component']).toBe('lanes');
    expect(policy.spec?.policyTypes).toEqual(['Ingress']);
    expect(policy.spec?.ingress ?? []).toEqual([]);
  });
});
