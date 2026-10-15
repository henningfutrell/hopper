// The kind check (issue #1281, docs/deploy.md "Check the chart on kind"): on a fresh kind cluster, `helm install` alone
// brings up the hopper, and no pod anywhere in the cluster has a Podman or Docker socket, or runs Podman, Docker or
// compose. Then `helm upgrade` with the same values runs the OpenFGA migration Job no second time (issue #1282). Needs
// `kind`, `helm` and `kubectl` on PATH, and a container runtime for kind.
//
//   node scripts/kind-check.ts [--cluster NAME] [--tag TAG] [--keep] [--set key=value ...]
//
// --cluster names the kind cluster (default hopper-check), --tag the hopper's image tag (default: the chart's), --set
// passes more values to the chart, and --keep keeps the cluster at the end. Exit 0 when the check passes, 1 when not.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CHART = join(import.meta.dirname, '..', 'deploy', 'helm', 'hopper');
const NAMESPACE = 'hopper';
const PORT = 4790;

interface Container {
  name: string; image: string;
  env?: { name: string }[];
  volumeMounts?: { mountPath: string }[];
}
interface Pod {
  metadata: { namespace: string; name: string };
  spec: { volumes?: { hostPath?: { path: string } }[]; containers: Container[]; initContainers?: Container[] };
}

const SOCKET_PATH = /docker\.sock|podman\.sock|^\/run\/podman|^\/var\/run\/docker|^\/run\/docker/;
const SOCKET_VARIABLE = /^(HOPPER_PODMAN_SOCKET|HOPPER_DOCKER_SOCKET|DOCKER_HOST|CONTAINER_HOST)$/;
// A path segment of the image's name: podman, docker (not docker.io, a registry), dind, compose.
const RUNTIME_IMAGE = /(^|\/)(podman|podman-compose|docker|compose)(\/|:|@|$)|dind/;

/** What in each pod is a container runtime socket, or a container runtime: one line per finding. */
function findings(pods: Pod[]): string[] {
  const out: string[] = [];
  for (const p of pods) {
    const at = `${p.metadata.namespace}/${p.metadata.name}`;
    for (const v of p.spec.volumes ?? []) if (v.hostPath && SOCKET_PATH.test(v.hostPath.path)) out.push(`${at}: host path ${v.hostPath.path}`);
    for (const c of [...p.spec.containers, ...(p.spec.initContainers ?? [])]) {
      if (RUNTIME_IMAGE.test(c.image)) out.push(`${at}/${c.name}: image ${c.image}`);
      for (const m of c.volumeMounts ?? []) if (SOCKET_PATH.test(m.mountPath)) out.push(`${at}/${c.name}: mount ${m.mountPath}`);
      for (const e of c.env ?? []) if (SOCKET_VARIABLE.test(e.name)) out.push(`${at}/${c.name}: variable ${e.name}`);
    }
  }
  return out;
}

function sh(cmd: string, args: string[], capture = false): { status: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** The check, on a cluster made for it. Answers what failed, or null. */
function check(context: string, tag: string | undefined, sets: string[]): string | null {
  const values = [...(tag ? [`image.tag=${tag}`] : []), ...sets];
  const install = sh('helm', ['install', 'hopper', CHART, '--kube-context', context, '--namespace', NAMESPACE, '--create-namespace',
    '--wait', '--wait-for-jobs', '--timeout', '15m', ...values.flatMap((v) => ['--set', v])]);
  if (install.status !== 0) return 'helm install did not bring up the release';

  // Asked on the pod's loopback, as its probes ask: from outside the pod it would be a LAN request.
  const health = `fetch('http://127.0.0.1:${PORT}/api/health').then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))`;
  const h = sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'exec', 'deploy/hopper', '-c', 'hopper', '--', 'node', '-e', health], true);
  let ok = false;
  try { ok = h.status === 0 && (JSON.parse(h.stdout) as { ok?: unknown }).ok === true; } catch { /* not JSON */ }
  if (!ok) return `the hopper's health is not ok: ${h.stdout.trim() || `exit ${h.status}`}`;
  console.log(`health: ${h.stdout.trim()}`);

  const list = sh('kubectl', ['--context', context, 'get', 'pods', '--all-namespaces', '-o', 'json'], true);
  if (list.status !== 0) return 'kubectl could not list the pods';
  const pods = (JSON.parse(list.stdout) as { items: Pod[] }).items;
  const found = findings(pods);
  if (found.length > 0) return `a container runtime in the cluster:\n${found.map((f) => `  ${f}`).join('\n')}`;
  console.log(`${pods.length} pods, no container runtime socket, no Podman, Docker or compose`);
  return migratesOnce(context);
}

/** An upgrade with the same values leaves the OpenFGA migration Job as it was: the migration ran once. */
function migratesOnce(context: string): string | null {
  const jobs = (): string => sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'get', 'jobs',
    '-l', 'app.kubernetes.io/component=openfga-migrate', '-o', 'jsonpath={.items[*].metadata.uid}'], true).stdout.trim();
  const before = jobs();
  if (!before) return 'the install made no OpenFGA migration Job';
  const upgrade = sh('helm', ['upgrade', 'hopper', CHART, '--kube-context', context, '--namespace', NAMESPACE, '--reuse-values',
    '--wait', '--wait-for-jobs', '--timeout', '10m']);
  if (upgrade.status !== 0) return 'helm upgrade with the same values did not succeed';
  const after = jobs();
  if (after !== before) return `the upgrade ran the OpenFGA migration again: Job ${before} became ${after || 'none'}`;
  console.log('the upgrade ran the OpenFGA migration no second time');
  return null;
}

const { values: opts } = parseArgs({
  options: {
    cluster: { type: 'string', default: 'hopper-check' },
    tag: { type: 'string' },
    keep: { type: 'boolean', default: false },
    set: { type: 'string', multiple: true, default: [] },
  },
});
const cluster = opts.cluster;
const context = `kind-${cluster}`;

let failure: string | null;
if (sh('kind', ['create', 'cluster', '--name', cluster, '--wait', '180s']).status !== 0) {
  failure = 'kind could not make the cluster';
} else {
  try {
    failure = check(context, opts.tag, opts.set);
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure) sh('kubectl', ['--context', context, 'get', 'pods', '--all-namespaces', '-o', 'wide']);
}
if (opts.keep) console.log(`The cluster stays: kubectl --context ${context} …; remove it with kind delete cluster --name ${cluster}`);
else sh('kind', ['delete', 'cluster', '--name', cluster]);

if (failure) {
  console.error(`kind check failed: ${failure}`);
  process.exit(1);
}
console.log('kind check passed');
