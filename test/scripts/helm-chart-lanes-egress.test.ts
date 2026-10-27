import { describe, expect, it } from 'vitest';
import { container, env, find, helm, render, type Resource } from '../support/helm-chart.ts';

// A lane pod's egress (issue #2849 part 6, docs/deploy.md "Lane pods on Kubernetes"): with lanes.egress.confine, the lane
// pods' NetworkPolicy lets them reach only DNS and the hopper, so the hopper's job egress allowlist is their one way out,
// and the lane container says so (HOPPER_EGRESS_CONTAINED) to the job's bare runner.
interface Peer { podSelector?: { matchLabels?: Record<string, string> }; namespaceSelector?: object; ipBlock?: { cidr: string } }
interface Rule { to?: Peer[]; ports?: { port: number; protocol?: string }[] }
const egressOf = (r: Resource): Rule[] => (r.spec?.egress ?? []) as Rule[];

const RUNNER = ['hopper.enabled=false', 'lanes.replicas=1', 'lanes.existingSecret=runner-pool-key', 'lanes.egress.confine=true'];

describe('the Helm chart\'s lane pods: their egress (issue #2849 part 6)', () => {
  it('off by default: the policy holds ingress only, and the lane container is not contained', () => {
    const rs = render('lanes.replicas=1');
    expect(find(rs, 'NetworkPolicy', 'hopper-lanes').spec?.policyTypes).toEqual(['Ingress']);
    expect(env(container(find(rs, 'StatefulSet', 'hopper-lanes'), 'lane'), 'HOPPER_EGRESS_CONTAINED')).toBeUndefined();
  });

  it('confined: a lane pod reaches only DNS and the hopper\'s own pod on its port, and the lane container says it is contained', () => {
    const rs = render('lanes.replicas=1', 'lanes.egress.confine=true');
    const policy = find(rs, 'NetworkPolicy', 'hopper-lanes');
    expect(policy.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec?.ingress ?? []).toEqual([]);
    const [dns, hopper, ...rest] = egressOf(policy);
    expect(rest).toEqual([]);
    expect(dns?.to).toEqual([{ namespaceSelector: {}, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }]);
    expect(dns?.ports).toEqual([{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }]);
    expect(hopper?.to).toHaveLength(1);
    expect(hopper?.to?.[0]?.podSelector?.matchLabels?.['app.kubernetes.io/component']).toBe('hopper');
    expect(hopper?.to?.[0]?.ipBlock).toBeUndefined();
    expect(hopper?.ports).toEqual([{ port: 4790, protocol: 'TCP' }]);
    expect(env(container(find(rs, 'StatefulSet', 'hopper-lanes'), 'lane'), 'HOPPER_EGRESS_CONTAINED')?.value).toBe('1');
  });

  it('another DNS selector, and the hopper on another port', () => {
    const policy = find(render('lanes.replicas=1', 'lanes.egress.confine=true', 'lanes.egress.dnsSelector.k8s-app=null', 'lanes.egress.dnsSelector.app=dns', 'port=8080'), 'NetworkPolicy', 'hopper-lanes');
    expect(egressOf(policy)[0]?.to?.[0]?.podSelector?.matchLabels).toEqual({ app: 'dns' });
    expect(egressOf(policy)[1]?.ports).toEqual([{ port: 8080, protocol: 'TCP' }]);
  });

  it('a runner-only release reaches the hopper at the addresses lanes.egress.hopperCidrs names, on its URL\'s port', () => {
    const at = (url: string): Rule | undefined => egressOf(find(render(...RUNNER, `lanes.hopperUrl=${url}`, 'lanes.egress.hopperCidrs={192.0.2.10/32,198.51.100.0/24}'), 'NetworkPolicy', 'hopper-lanes'))[1];
    const rule = at('https://hopper.example.com:8443');
    expect(rule?.to).toEqual([{ ipBlock: { cidr: '192.0.2.10/32' } }, { ipBlock: { cidr: '198.51.100.0/24' } }]);
    expect(rule?.ports).toEqual([{ port: 8443, protocol: 'TCP' }]);
    expect(at('https://hopper.example.com')?.ports).toEqual([{ port: 443, protocol: 'TCP' }]);
    expect(at('http://hopper.example.com')?.ports).toEqual([{ port: 80, protocol: 'TCP' }]);
  });

  it('refuses a confined runner-only release that names no address of its hopper', () => {
    const out = helm(['template', 'hopper', '/chart', ...[...RUNNER, 'lanes.hopperUrl=https://hopper.example.com'].flatMap((s) => ['--set', s])]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/lanes\.egress\.hopperCidrs/);
  });
});
