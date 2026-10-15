// Issue #1281 acceptance: scripts/kind-check.ts brings up a fresh kind cluster, installs the Helm chart with `helm
// install` alone, asks the hopper's health in its pod, and checks that no pod anywhere in the cluster has a Podman or
// Docker socket, or runs Podman, Docker or compose. Each test runs the script with fake `kind`, `helm` and `kubectl`
// first on its PATH, which write what they were asked to a log, so nothing here starts a cluster.
//
// Feature: the cluster install needs no container runtime socket
//   Scenario: a fresh cluster with the chart installed and the hopper healthy passes, and the cluster is deleted
//   Scenario: a pod with a Docker socket, a Podman image or a socket variable fails the check, and names the pod
//   Scenario: a hopper that is not healthy fails the check
//   Scenario: with --keep the cluster stays
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  { metadata: { namespace: 'kube-system', name: 'kube-proxy-x' }, spec: { volumes: [{ name: 'lib-modules', hostPath: { path: '/lib/modules' } }], containers: [{ name: 'kube-proxy', image: 'registry.k8s.io/kube-proxy:v1.34.0' }] } },
];

function tool(name: string, script: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

function fakes(pods: Pod[], health = '{"ok":true,"version":"1.0.0","uptimeS":3}'): void {
  writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: pods }));
  writeFileSync(join(dir, 'health.json'), health);
  tool('kind', 'exit 0');
  tool('helm', 'exit 0');
  tool('kubectl', [
    'case "$*" in',
    `  *" exec "*) cat "${join(dir, 'health.json')}" ;;`,
    `  *"get pods --all-namespaces -o json"*) cat "${join(dir, 'pods.json')}" ;;`,
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
    expect(install).toBe(`helm install hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --create-namespace --wait --timeout 15m --set image.tag=dev --set sandbox.enabled=true`);
    expect(r.calls).toContain('kubectl --context kind-hopper-check --namespace hopper exec deploy/hopper -c hopper -- node -e '
      + "fetch('http://127.0.0.1:4790/api/health').then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))");
    expect(r.calls).toContain('kubectl --context kind-hopper-check get pods --all-namespaces -o json');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
    expect(r.stdout).toContain('3 pods, no container runtime socket');
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

  it('keeps the cluster with --keep, under the name --cluster gives', () => {
    fakes(clean);
    const r = run('--cluster', 'mine', '--keep');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls[0]).toBe('kind create cluster --name mine --wait 180s');
    expect(r.calls.some((c) => c.startsWith('kind delete'))).toBe(false);
    expect(r.stdout).toContain('kind delete cluster --name mine');
  });
});
