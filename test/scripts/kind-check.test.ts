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
//   Scenario: then `kubectl rollout restart` of a default install comes back healthy on the same key (issues #1406,
//             #1422)
//   Scenario: then a person signs in with no GitHub (issue #1380): the CLI in the hopper's pod adds the first admin's local
//             account, its password on stdin only; in the pod that account signs in, mints a grant, and the grant's
//             refreshed API token reads that person's grants
//   Scenario: a sign-in or a grant that does not work, a local account that is not admin, or a CLI that fails fails the
//             check
//   Scenario: then the machines come up as pods (sandbox boxes, a lane pod) by an upgrade of the same release, the hopper
//             stays healthy on the same key, and still no pod has a container runtime socket
//   Scenario: a lane pod that does not come up fails the check
//   Scenario: with --keep the cluster stays
//   Scenario: a pull request that changes the chart runs the check, with no secret
//   Scenario: then the sandbox check of the checkout runs on the cluster it kept, and the cluster is deleted (issue #1371)
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
// The hopper's start line about its key (src/secrets/master-key.ts logMasterKey).
const status = (fingerprint: string, source = 'given'): string => `hopper: master key: given at launch as HOPPER_MASTER_KEY or its file (${source}), fingerprint ${fingerprint}`;

// What the sign-in in the pod prints (scripts/kind-check.ts SIGN_IN_AND_GRANT), and how the CLI and it end.
const SIGNED_IN = '{"realm":"local-accounts","role":"admin","holders":["kind-check"]}';
interface SignIn { out?: string; status?: number; addStatus?: number }

function fakes(pods: Pod[], health = '{"ok":true,"version":"1.0.0","uptimeS":3}', migrations = ['uid-1', 'uid-1'], keys = [status(FINGERPRINT)], signIn: SignIn = {}): void {
  writeFileSync(join(dir, 'signin.json'), signIn.out ?? SIGNED_IN);
  writeFileSync(join(dir, 'jobs'), migrations.join('\n') + '\n');
  // Each read of the hopper's log answers the next line; the last one stays.
  writeFileSync(join(dir, 'keys'), keys.join('\n') + '\n');
  writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: pods }));
  writeFileSync(join(dir, 'health.json'), health);
  tool('kind', 'exit 0');
  tool('helm', 'exit 0');
  tool('kubectl', [
    'case "$*" in',
    `  *" logs deploy/hopper "*) echo 'hopper: listening'; head -n 1 "${join(dir, 'keys')}"; if [ "$(wc -l < "${join(dir, 'keys')}")" -gt 1 ]; then sed -i 1d "${join(dir, 'keys')}"; fi ;;`,
    // The CLI in the pod keeps what came on its stdin; the sign-in script too, and answers what it read.
    `  *" exec -i deploy/hopper -c hopper -- hopper local-account add "*) cat > "${join(dir, 'cli-stdin')}"; exit ${signIn.addStatus ?? 0} ;;`,
    `  *" exec -i deploy/hopper -c hopper -- node -e "*) cat > "${join(dir, 'signin-stdin')}"; cat "${join(dir, 'signin.json')}"; exit ${signIn.status ?? 0} ;;`,
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
    const restart = at('kubectl --context kind-hopper-check --namespace hopper rollout restart deployment/hopper');
    // The boxes get little each, which a kind node on a CI runner can give: the sandbox check reads it from the chart.
    const sandbox = at(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --wait --wait-for-jobs --timeout 15m --set sandbox.enabled=true --set sandbox.limits.cpus=0.25 --set sandbox.limits.memoryMb=128`);
    // No --wait: a lane pod is ready only once a person signed in, and its spec is what the check reads.
    const lanes = at(`helm upgrade hopper ${CHART} --kube-context kind-hopper-check --namespace hopper --reuse-values --set lanes.replicas=1`);
    const created = at('kubectl --context kind-hopper-check --namespace hopper wait --for=create pod/hopper-lanes-0 --timeout=180s');
    expect(migration).toBeLessThan(restarted);
    expect(restarted).toBeLessThan(restart);
    expect(restart).toBeLessThan(sandbox);
    expect(sandbox).toBeLessThan(lanes);
    expect(lanes).toBeLessThan(created);
    expect(r.calls.filter((c) => c.includes(' exec deploy/hopper ') && c.includes('/api/health'))).toHaveLength(4);
    expect(r.calls.filter((c) => c === 'kubectl --context kind-hopper-check --namespace hopper logs deploy/hopper -c hopper')).toHaveLength(4);
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

  it('restarts the hopper with rollout restart, waits for it, and asks its health and key again (issues #1406, #1422)', () => {
    fakes(clean);
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const restart = r.calls.indexOf('kubectl --context kind-hopper-check --namespace hopper rollout restart deployment/hopper');
    expect(restart).toBeGreaterThan(-1);
    const rollout = r.calls.indexOf('kubectl --context kind-hopper-check --namespace hopper rollout status deployment/hopper --timeout=5m', restart);
    expect(rollout).toBeGreaterThan(restart);
    const health = r.calls.findIndex((c, i) => i > rollout && c.includes(' exec deploy/hopper ') && c.includes('/api/health'));
    const key = r.calls.findIndex((c, i) => i > health && c.includes(' logs deploy/hopper '));
    expect(health).toBeGreaterThan(rollout);
    expect(key).toBeGreaterThan(health);
    expect(r.stdout).toContain(`after rollout restart the hopper is healthy on the same master key (fingerprint ${FINGERPRINT})`);
  });

  it('then signs in with no GitHub: the CLI in the pod adds the first admin, its password on stdin only, and a grant reads as them (issue #1380)', () => {
    fakes(clean);
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const restart = r.calls.indexOf('kubectl --context kind-hopper-check --namespace hopper rollout restart deployment/hopper');
    const add = r.calls.indexOf('kubectl --context kind-hopper-check --namespace hopper exec -i deploy/hopper -c hopper -- hopper local-account add admin@example.com');
    const signIn = r.calls.findIndex((c) => c.startsWith('kubectl --context kind-hopper-check --namespace hopper exec -i deploy/hopper -c hopper -- node -e '));
    const sandbox = r.calls.findIndex((c) => c.includes('sandbox.enabled=true'));
    expect(add).toBeGreaterThan(restart);
    expect(signIn).toBeGreaterThan(add);
    expect(sandbox).toBeGreaterThan(signIn);
    const password = readFileSync(join(dir, 'cli-stdin'), 'utf8').trim();
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(readFileSync(join(dir, 'signin-stdin'), 'utf8')).toBe(password);
    expect(r.calls.some((c) => c.includes(password))).toBe(false);
    // The script is one argument over many lines of the log.
    const script = readFileSync(log, 'utf8');
    for (const route of ['/ui/auth/password', '/ui/api/session', '/ui/api/api-tokens', '/ui/auth/token/refresh', '/api/api-tokens']) expect(script).toContain(route);
    expect(r.stdout).toContain('a local account signed in with no GitHub, minted a grant, and its refreshed API token read as that person');
  });

  it('fails when the CLI in the pod cannot add the local account', () => {
    fakes(clean, undefined, undefined, undefined, { addStatus: 2 });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hopper local-account add in the hopper\'s pod did not succeed: exit 2');
    expect(r.calls.at(-1)).toBe('kind delete cluster --name hopper-check');
  });

  it('fails when the sign-in or the grant does not work, and says why', () => {
    fakes(clean, undefined, undefined, undefined, { out: '{"error":"/ui/auth/password: 403 {}"}', status: 1 });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a sign-in with no GitHub and a grant did not work: /ui/auth/password: 403 {}');
  });

  it('fails when the local account is not admin through local-accounts, or the token reads other grants', () => {
    fakes(clean, undefined, undefined, undefined, { out: '{"realm":"corp","role":"viewer","holders":["kind-check"]}' });
    expect(run().stderr).toContain('the local account signed in as viewer through corp, not as admin through local-accounts');
    rmSync(log);
    fakes(clean, undefined, undefined, undefined, { out: '{"realm":"local-accounts","role":"admin","holders":["kind-check","other"]}' });
    expect(run().stderr).toContain('the grant\'s API token read the grants ["kind-check","other"], not the one it was minted with');
  });

  it('fails when the hopper after rollout restart runs on another master key', () => {
    fakes(clean, undefined, undefined, [status(FINGERPRINT), status(FINGERPRINT), status('ffffffffffffffff')]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`after rollout restart the hopper runs on the master key of fingerprint ffffffffffffffff, not ${FINGERPRINT}`);
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

  const steps = Object.values(workflow.jobs).flatMap((j) => j.steps) as { run?: string; if?: string }[];
  const runs = steps.map((s) => s.run ?? '');

  it('runs the kind check with the dev channel\'s image, and keeps the cluster for the sandbox check', () => {
    expect(runs).toContain('node scripts/kind-check.ts --tag dev --keep');
  });

  it('then runs the sandbox check of this checkout on that cluster, and deletes the cluster whatever the result (issue #1371)', () => {
    const at = (run: string): number => runs.indexOf(run);
    expect(at('npm ci')).toBeGreaterThan(-1);
    expect(at('npm ci')).toBeLessThan(at('node scripts/kind-sandbox-check.ts --context kind-hopper-check'));
    expect(at('node scripts/kind-check.ts --tag dev --keep')).toBeLessThan(at('node scripts/kind-sandbox-check.ts --context kind-hopper-check'));
    const remove = steps.find((s) => s.run === 'kind delete cluster --name hopper-check');
    expect(remove?.if).toBe('always()');
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining(['scripts/kind-sandbox-check.ts']));
  });

  it('runs on every change of the sandbox module and the types it runs on, not only the Kubernetes runtime (issue #1422)', () => {
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining(['src/sandbox/**', 'src/domain/sandboxes.ts', 'src/domain/sandbox-runs.ts']));
  });

  it('runs the migration check too, on a pull request that changes it or the cluster script (issue #1373)', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining(['scripts/kind-migrate-check.ts', 'scripts/hopper-cluster.sh']),
    );
    const runs = Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    expect(runs).toContain('node scripts/kind-migrate-check.ts --tag dev');
  });
});
