// The Kubernetes cluster of the cloud acceptance tests (issue #1956, criterion 8): a kind cluster made for the test run
// (`kind create cluster`, on the container runtime HOPPER_TEST_CONTAINER_CLI names), or the cluster an admin kubeconfig
// names (HOPPER_TEST_KUBECONFIG; it is not deleted). Seeded with the service accounts a minting credential of type
// `token` works with: `hopper-read` in the namespace `hopper`, bound to the cluster's own `view` role, and
// `hopper-minter`, which may only make tokens and the Secrets they are bound to in `hopper`. The namespace `app` holds
// the workload a job reads: a pod, a ConfigMap and a Secret. The real `kubectl` (HOPPER_TEST_KUBECTL) runs on this
// machine with the admin kubeconfig.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KUBE_CLUSTER_NAMESPACE } from '../../../src/domain/minting.ts';
import type { Run } from './aws-cli.ts';

const KIND = process.env.HOPPER_TEST_KIND ?? 'kind';
const KUBECTL = process.env.HOPPER_TEST_KUBECTL ?? 'kubectl';
const CLI = process.env.HOPPER_TEST_CONTAINER_CLI ?? 'docker';
/** The namespace of the workload a job reads. */
export const APP_NAMESPACE = 'app';
/** The seeded pod, ConfigMap and Secret of the workload. */
export const SEED_POD = 'seed';
export const SEED_CONFIG = 'settings';
export const SEED_SECRET = 'db-password';
/** The service account a read is minted for (`mintTarget`: `hopper-<operation>`), and the minting credential's own. */
export const READ_ACCOUNT = 'hopper-read';
const MINTER_ACCOUNT = 'hopper-minter';

export interface Cluster {
  /** The API server, as this machine and a box on its network reach it. */
  server: string;
  /** The API server's CA, base64, as a kubeconfig holds it. */
  certificateAuthorityData: string;
  /** A token of `hopper-minter`: the minting credential's. */
  mintingToken: string;
  /** The real kubectl with the admin kubeconfig: its exit code and output; never rejects. */
  admin(args: string[], input?: string): Promise<Run>;
  /** The real kubectl as `token`, with no kubeconfig of its own. */
  as(token: string, args: string[]): Promise<Run>;
  end(): Promise<void>;
}

/** `command` with `args`, its exit code and output; never rejects. */
function run(command: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env: { ...process.env, ...o.env }, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) || 1 : 0, stdout, stderr });
    });
    child.stdin?.end(o.input ?? '');
  });
}

const must = async (what: string, r: Promise<Run>): Promise<Run> => {
  const done = await r;
  if (done.code !== 0) throw new Error(`${what} failed (${done.code}): ${done.stderr || done.stdout}`);
  return done;
};

/** The seed: what the minting credential and a read need, and the workload. */
const SEED = `apiVersion: v1
kind: Namespace
metadata: { name: ${KUBE_CLUSTER_NAMESPACE} }
---
apiVersion: v1
kind: Namespace
metadata: { name: ${APP_NAMESPACE} }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: ${READ_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: ${READ_ACCOUNT}-view }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: ${READ_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }]
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: ${MINTER_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: ${MINTER_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }
rules:
  - { apiGroups: [""], resources: [secrets], verbs: [create, delete] }
  - { apiGroups: [""], resources: [serviceaccounts/token], verbs: [create] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ${MINTER_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: ${MINTER_ACCOUNT} }
subjects: [{ kind: ServiceAccount, name: ${MINTER_ACCOUNT}, namespace: ${KUBE_CLUSTER_NAMESPACE} }]
---
apiVersion: v1
kind: ConfigMap
metadata: { name: ${SEED_CONFIG}, namespace: ${APP_NAMESPACE} }
data: { mode: read }
---
apiVersion: v1
kind: Secret
metadata: { name: ${SEED_SECRET}, namespace: ${APP_NAMESPACE} }
stringData: { password: seeded-never-read }
---
apiVersion: v1
kind: Pod
metadata: { name: ${SEED_POD}, namespace: ${APP_NAMESPACE} }
spec:
  automountServiceAccountToken: false
  containers: [{ name: pause, image: registry.k8s.io/pause:3.10 }]
`;

/** A kind cluster made for this run (or the one HOPPER_TEST_KUBECONFIG names), seeded. */
export async function startCluster(): Promise<Cluster> {
  const given = process.env.HOPPER_TEST_KUBECONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-kind-'));
  const name = `hopper-acceptance-${process.pid}`;
  const kubeconfig = given ?? join(dir, 'kubeconfig');
  // kind takes the runtime from KIND_EXPERIMENTAL_PROVIDER; docker is its default.
  const kindEnv: Record<string, string> = CLI === 'podman' ? { KIND_EXPERIMENTAL_PROVIDER: 'podman' } : {};
  const end = async (): Promise<void> => {
    if (!given) await run(KIND, ['delete', 'cluster', '--name', name], { env: kindEnv });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (!given) await must('kind create cluster', run(KIND, ['create', 'cluster', '--name', name, '--kubeconfig', kubeconfig, '--wait', '180s'], { env: kindEnv }));
    const admin = (args: string[], input?: string) => run(KUBECTL, ['--kubeconfig', kubeconfig, ...args], input === undefined ? {} : { input });
    await must('the seed', admin(['apply', '-f', '-'], SEED));
    const view = JSON.parse((await must('the kubeconfig', admin(['config', 'view', '--raw', '--minify', '-o', 'json']))).stdout) as { clusters: { cluster: { server: string; 'certificate-authority-data'?: string; 'certificate-authority'?: string } }[] };
    const c = view.clusters[0]!.cluster;
    const certificateAuthorityData = c['certificate-authority-data'] ?? readFileSync(c['certificate-authority']!).toString('base64');
    const mintingToken = (await must('the minting token', admin(['create', 'token', MINTER_ACCOUNT, '-n', KUBE_CLUSTER_NAMESPACE, '--duration', '2h']))).stdout.trim();
    const ca = join(dir, 'ca.crt');
    writeFileSync(ca, Buffer.from(certificateAuthorityData, 'base64'));
    return {
      server: c.server, certificateAuthorityData, mintingToken, admin,
      as: (token, args) => run(KUBECTL, ['--kubeconfig', '/dev/null', '--server', c.server, '--certificate-authority', ca, '--token', token, ...args]),
      end,
    };
  } catch (e) {
    await end();
    throw e;
  }
}
