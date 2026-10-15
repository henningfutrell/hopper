import { describe, expect, it } from 'vitest';
import { container, env, find, pod, render, type Resource, workloads } from '../support/helm-chart.ts';

// Sandbox boxes as pods (issue #1286, docs/deploy.md "Sandbox boxes on Kubernetes"): with sandbox.enabled the hopper
// starts its boxes through the Kubernetes API, with its own service account and the Role the runtime needs in its
// namespace, and no container socket anywhere.
interface Rule { apiGroups: string[]; resources: string[]; verbs: string[] }
type Rbac = Resource & { rules?: Rule[]; roleRef?: { kind: string; name: string }; subjects?: { kind: string; name: string; namespace?: string }[] };

describe('the Helm chart\'s sandbox boxes', () => {
  const rs = render('sandbox.enabled=true');
  const hopper = find(rs, 'Deployment', 'hopper');
  const daemon = container(hopper, 'hopper');

  it('starts no sandbox boxes, and makes no Role, unless asked', () => {
    const off = render();
    const d = container(find(off, 'Deployment', 'hopper'), 'hopper');
    expect(env(d, 'HOPPER_SANDBOX_RUNTIME')).toBeUndefined();
    expect(off.filter((r) => ['Role', 'RoleBinding', 'ServiceAccount'].includes(r.kind))).toEqual([]);
  });

  it('starts boxes as pods through the Kubernetes API, never through a socket', () => {
    expect(env(daemon, 'HOPPER_SANDBOX_RUNTIME')?.value).toBe('kubernetes');
    for (const e of daemon.env ?? []) expect(e.name).not.toMatch(/^HOPPER_(PODMAN|DOCKER)_SOCKET$/);
    // The boxes start in the release's namespace, where they dial the hopper's Service by its short name.
    expect(env(daemon, 'HOPPER_KUBERNETES_NAMESPACE')).toBeUndefined();
    expect(env(daemon, 'HOPPER_LAN_NAMES')?.value?.split(',')[0]).toBe('hopper');
  });

  it('lets a box reach the hopper\'s pod alone, by all of its labels: not Postgres, OpenFGA or Solr', () => {
    const labels = Object.fromEntries((env(daemon, 'HOPPER_KUBERNETES_HOPPER_LABELS')?.value ?? '').split(',').map((l) => l.split('=')));
    expect(labels).toEqual({ 'app.kubernetes.io/name': 'hopper', 'app.kubernetes.io/instance': 'hopper', 'app.kubernetes.io/component': 'hopper' });
    for (const [k, v] of Object.entries(labels)) expect(hopper.spec?.template?.metadata?.labels?.[k]).toBe(v);
    for (const w of workloads(rs).filter((x) => x !== hopper)) {
      const other = w.spec?.template?.metadata?.labels ?? {};
      expect(Object.entries(labels).every(([k, v]) => other[k] === v), w.metadata.name).toBe(false);
    }
  });

  it('runs the hopper as a service account of its own, with its token: the API client reads it', () => {
    expect(pod(hopper).serviceAccountName).toBe('hopper');
    expect(find(rs, 'ServiceAccount', 'hopper')).toBeDefined();
    expect(pod(hopper).automountServiceAccountToken).toBe(true);
    // Only the hopper: no other pod gets a token.
    for (const w of workloads(rs).filter((x) => x !== hopper)) expect(pod(w).automountServiceAccountToken, w.metadata.name).toBe(false);
  });

  it('binds the service account to the Role the runtime needs, in the release\'s namespace, and to nothing more', () => {
    const role = find(rs, 'Role', 'hopper-sandbox') as Rbac;
    const grants = (role.rules ?? []).flatMap((r) => r.resources.flatMap((res) => r.verbs.map((v) => `${r.apiGroups.join('')}/${res}:${v}`))).sort();
    expect(grants).toEqual([
      '/persistentvolumeclaims:create', '/persistentvolumeclaims:delete', '/persistentvolumeclaims:get', '/persistentvolumeclaims:list',
      '/pods/exec:create', '/pods/exec:get', '/pods/log:get',
      '/pods:create', '/pods:delete', '/pods:get', '/pods:list',
      'networking.k8s.io/networkpolicies:create', 'networking.k8s.io/networkpolicies:update',
    ].sort());
    expect(rs.filter((r) => r.kind === 'ClusterRole' || r.kind === 'ClusterRoleBinding')).toEqual([]);
    const binding = find(rs, 'RoleBinding', 'hopper-sandbox') as Rbac;
    expect(binding.roleRef).toMatchObject({ kind: 'Role', name: 'hopper-sandbox' });
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'hopper', namespace: 'hopper' }]);
  });

  it('binds the Role to the service account it is given', () => {
    const given = render('sandbox.enabled=true', 'serviceAccount.name=ops');
    expect(pod(find(given, 'Deployment', 'hopper')).serviceAccountName).toBe('ops');
    expect(given.filter((r) => r.kind === 'ServiceAccount')).toEqual([]);
    expect((find(given, 'RoleBinding', 'hopper-sandbox') as Rbac).subjects?.[0]?.name).toBe('ops');
  });
});
