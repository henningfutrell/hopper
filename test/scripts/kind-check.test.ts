// Issue #1281 acceptance: scripts/kind-check.ts brings up a fresh kind cluster, installs the Helm chart with `helm
// install` alone, asks the hopper's health in its pod, and checks that no pod anywhere in the cluster has a Podman or
// Docker socket, or runs Podman, Docker or compose. Each test runs the script with fake `kind`, `helm` and `kubectl`
// first on its PATH, which write what they were asked to a log, so nothing here starts a cluster.
//
// Feature: the cluster install needs no container runtime socket
//   Scenario: a fresh cluster with the chart installed and the hopper healthy passes, and the cluster is deleted
//   Scenario: a pod with a Docker socket, a Podman image or a socket variable fails the check, and names the pod
//   Scenario: a hopper that is not healthy fails the check
//   Scenario: an upgrade with the same values that runs the OpenFGA migration again fails the check (issue #1282)
//   Scenario: the hopper's pod deleted, the new one runs on the master key of the same fingerprint, the key the chart
//             made (issue #1406)
//   Scenario: a new pod on another key fails the check
//   Scenario: then the machines come up as pods (sandbox boxes, a lane pod) by an upgrade of the same release, the hopper
//             stays healthy on the same key, and still no pod has a container runtime socket
//   Scenario: a lane pod that does not come up fails the check
//   Scenario: with --keep the cluster stays
//   Scenario: a pull request that changes the chart runs the check, with no secret
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'kind-check.ts');
const CHART = join(ROOT, 'deploy', 'helm', 'hopper');

let dir: string;
let bin: string;
let log: string;

interface Pod {
  metadata: { namespace: string; name: string };
  spec: {
    volumes?: { name: string; hostPath?: { path: string } }[];
    containers: { name: string; image: string; env?: { name: string; value?: string }[]; volumeMounts?: { name: string; mountPath: string }[] }[];
    initContainers?: { name: string; image: string }[];
  };
}

const clean: Pod[] = [
  { metadata: { namespace: 'hopper', name: 'hopper-6f9d' }, spec: { containers: [{ name: 'hopper', image: 'ghcr.io/henningfutrell/hopper:dev', env: [{ name: 'HOPPER_SANDBOX_RUNTIME', value: 'kubernetes' }] }], initContainers: [{ name: 'wait-for-postgres', image: 'postgres:17-alpine' }] } },
  { metadata: { namespace: 'hopper', name: 'hopper-openfga-1a' }, spec: { containers: [{ name: 'openfga', image: 'docker.io/openfga/openfga:v1.22.0' }] } },
  { metadata: { namespace: 'hopper', name: 'hopper-lanes-0' }, spec: { containers: [{ name: 'lane', image: 'ghcr.io/henningfutrell/hopper:box-claude-dev' }], initContainers: [{ name: 'join', image: 'ghcr.io/henningfutrell/hopper:box-claude-dev' }] } },
  { metadata: { namespace: 'kube-system', name: 'kube-proxy-x' }, spec: { volumes: [{ name: 'lib-modules', hostPath: { path: '/lib/modules' } }], containers: [{ name: 'kube-proxy', image: 'registry.k8s.io/kube-proxy:v1.34.0' }] } },
];

function tool(name: string, script: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

const FINGERPRINT = 'a1b2c3d4e5f60718';
const status = (fingerprint: string, source = 'given'): string => JSON.stringify({ source, fingerprint, previous: false });

function fakes(pods: Pod[], health = '{"ok":true,"version":"1.0.0","uptimeS":3}', migrations = ['uid-1', 'uid-1'], keys = [status(FINGERPRINT)]): void {
  writeFileSync(join(dir, 'jobs'), migrations.join('\n') + '\n');
  // Each ask for the master key's status answers the next line; the last one stays.
  writeFileSync(join(dir, 'keys'), keys.join('\n') + '\n');
  writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: pods }));
  writeFileSync(join(dir, 'health.json'), health);
  tool('kind', 'exit 0');
  tool('helm', 'exit 0');
  tool('kubectl', [
    'case "$*" in',
    `  *"master-key status"*) head -n 1 "${join(dir, 'keys')}"; [ "$(wc -l < "${join(dir, 'keys')}")" -gt 1 ] && sed -i 1d "${join(dir, 'keys')}" ;;`,
    `  *" exec "*) cat "${join(dir, 'health.json')}" ;;`,
    `  *"get pods --all-namespaces -o json"*) cat "${join(dir, 'pods.json')}" ;;`,
    // Each ask for the migration Jobs answers the next line: before the upgrade, then after.
    `  *"get jobs"*) head -n 1 "${join(dir, 'jobs')}"; sed -i 1d "${join(dir, 'jobs')}" ;;`,
    '  *) echo "listed" ;;',
    'esac',
  ].join('\n'));
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string; calls: string[] } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
  let calls: string[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { /* none */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-kind-check-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  log = join(dir, 'calls.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('scripts/kind-check.ts', () => {
  it('makes a fresh cluster, installs the chart with helm install alone, asks the health, and deletes the cluster', () => {
    fakes(clean);
    const r = run('--tag', 'dev');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls[0]).toBe('kind create cluster --name hopper-check --wait 180s');
    const install = r.calls.find((c) => c.startsWith('helm '));
    expect(install).toBe(`helm install hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --create-namespace --wait --wait-for-jobs --timeout 15m --set image.tag=dev`);
    expect(r.calls).toContain(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --wait --wait-for-jobs --timeout 10m`);
    expect(r.stdout).toContain('the upgrade ran the OpenFGA migration no second time');
    expect(r.calls).toContain('kubectl --context kind-hopper-check --namespace hopper exec deploy/hopper -c hopper -- node -e '
      + "fetch('http://127.0.0.1:4790/api/health').then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))");
    expect(r.calls).toContain('kubectl --context kind-hopper-check get pods --all-namespaces -o json');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
    expect(r.stdout).toContain('4 pods, no container runtime socket');
  });

  it('then brings up the machines as pods, asks the health again, and checks the cluster again for a container runtime', () => {
    fakes(clean);
    const r = run('--tag', 'dev');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const at = (call: string): number => {
      const i = r.calls.indexOf(call);
      expect(i, `${call} in\n${r.calls.join('\n')}`).toBeGreaterThan(-1);
      return i;
    };
    const migration = at(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --wait --wait-for-jobs --timeout 10m`);
    // The key the chart made is kept (issue #1406): a new pod of the same release starts on it, so no fresh install.
    const restarted = at('kubectl --context kind-hopper-check --namespace hopper delete pod -l app.kubernetes.io/instance=hopper,app.kubernetes.io/component=hopper --wait=true --timeout=5m');
    expect(r.calls.some((c) => c.includes('create secret') || c.includes('delete namespace'))).toBe(false);
    const sandbox = at(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --wait --wait-for-jobs --timeout 15m --set sandbox.enabled=true`);
    // No --wait: a lane pod is ready only once a person signed in, and its spec is what the check reads.
    const lanes = at(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --set lanes.replicas=1`);
    const created = at('kubectl --context kind-hopper-check --namespace hopper wait --for=create pod/hopper-lanes-0 --timeout=180s');
    expect(migration).toBeLessThan(restarted);
    expect(restarted).toBeLessThan(sandbox);
    expect(sandbox).toBeLessThan(lanes);
    expect(lanes).toBeLessThan(created);
    expect(r.calls.filter((c) => c.includes(' exec deploy/hopper ') && c.includes('/api/health'))).toHaveLength(3);
    expect(r.calls.filter((c) => c.endsWith('exec deploy/hopper -c hopper -- hopper master-key status'))).toHaveLength(3);
    expect(r.stdout).toContain(`a new hopper pod runs on the same master key (fingerprint ${FINGERPRINT})`);
    expect(r.calls.slice(created).some((c) => c === 'kubectl --context kind-hopper-check get pods --all-namespaces -o json')).toBe(true);
    expect(r.stdout).toContain('machines as pods: sandbox boxes on, lane pod hopper-lanes-0');
  });

  it('waits for the new hopper pod after the delete, then asks its health and its key', () => {
    fakes(clean);
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const deleted = r.calls.findIndex((c) => c.includes(' delete pod -l '));
    const rollout = r.calls.indexOf('kubectl --context kind-hopper-check --namespace hopper rollout status deployment/hopper --timeout=5m');
    expect(deleted).toBeGreaterThan(-1);
    expect(rollout).toBeGreaterThan(deleted);
  });

  it('fails when the new hopper pod runs on another master key', () => {
    fakes(clean, undefined, undefined, [status(FINGERPRINT), status('ffffffffffffffff')]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the new hopper pod runs on the master key of fingerprint ffffffffffffffff, not ${FINGERPRINT}`);
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when the hopper made its own key: the chart gave it none', () => {
    fakes(clean, undefined, undefined, [status(FINGERPRINT, 'generated')]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the hopper\'s master key is not given at launch (source generated)');
  });

  it('fails when the lane pod does not come up', () => {
    fakes(clean.filter((p) => p.metadata.name !== 'hopper-lanes-0'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no lane pod');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when a pod has a Docker or Podman socket, a socket variable, or runs Podman, Docker or compose, and names each', () => {
    fakes([
      ...clean,
      { metadata: { namespace: 'default', name: 'builder' }, spec: { volumes: [{ name: 'sock', hostPath: { path: '/var/run/docker.sock' } }], containers: [{ name: 'b', image: 'alpine:3', volumeMounts: [{ name: 'sock', mountPath: '/var/run/docker.sock' }] }] } },
      { metadata: { namespace: 'hopper', name: 'podman-0' }, spec: { containers: [{ name: 'p', image: 'quay.io/podman/stable:v5' }] } },
      { metadata: { namespace: 'hopper', name: 'dind-0' }, spec: { containers: [{ name: 'd', image: 'docker.io/library/docker:27-dind' }] } },
      { metadata: { namespace: 'hopper', name: 'compose-0' }, spec: { containers: [{ name: 'c', image: 'docker/compose:1.29.2' }] } },
      { metadata: { namespace: 'hopper', name: 'env-0' }, spec: { containers: [{ name: 'e', image: 'alpine:3', env: [{ name: 'HOPPER_PODMAN_SOCKET', value: '/run/podman/podman.sock' }] }] } },
    ]);
    const r = run();
    expect(r.status).toBe(1);
    for (const p of ['default/builder', 'hopper/podman-0', 'hopper/dind-0', 'hopper/compose-0', 'hopper/env-0']) expect(r.stderr).toContain(p);
    expect(r.stderr).not.toContain('kube-proxy');
    expect(r.stderr).not.toContain('openfga');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when the hopper is not healthy', () => {
    fakes(clean, '{"ok":false}');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('health');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when an upgrade with the same values runs the OpenFGA migration again', () => {
    fakes(clean, undefined, ['uid-1', 'uid-2']);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OpenFGA migration');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when the install made no OpenFGA migration Job', () => {
    fakes(clean, undefined, ['', '']);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no OpenFGA migration Job');
  });

  it('keeps the cluster with --keep, under the name --cluster gives', () => {
    fakes(clean);
    const r = run('--cluster', 'mine', '--keep');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls[0]).toBe('kind create cluster --name mine --wait 180s');
    expect(r.calls.some((c) => c.startsWith('kind delete'))).toBe(false);
    expect(r.stdout).toContain('kind delete cluster --name mine');
  });
});

describe('.github/workflows/kind.yml, the kind check on a pull request', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'kind.yml'), 'utf8');
  const workflow = parse(text) as {
    on: { pull_request: { paths: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: { run?: string }[] }>;
  };

  it('runs on a pull request that changes the chart or the check, read-only and with no secret', () => {
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining(['deploy/helm/**', 'scripts/kind-check.ts']));
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
  });

  it('runs the kind check with the dev channel\'s image', () => {
    const runs = Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    expect(runs).toContain('node scripts/kind-check.ts --tag dev');
  });
});
