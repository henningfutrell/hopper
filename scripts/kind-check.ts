// The kind check (issue #1281, docs/deploy.md "Check the chart on kind"): on a fresh kind cluster, `helm install` alone
// brings up the hopper, and no pod anywhere in the cluster has a Podman or Docker socket, or runs Podman, Docker or
// compose. Then `helm upgrade` with the same values runs the OpenFGA migration Job no second time (issue #1282). Then the
// hopper's pod is deleted, and the new one runs on the master key of the same fingerprint: the key the chart made and
// keeps (issue #1406). Then `kubectl rollout restart` of the hopper: it comes back healthy on that key (issue #1422). Then
// a person signs in with no GitHub (issue #1380): the operator CLI in the hopper's pod adds the first admin's local
// account, who signs in with its email and password and mints a grant, and the grant's refreshed API token reads as that
// person. Then the machines come up as pods — by an upgrade of the same release, sandbox boxes on with little CPU and
// memory each, one lane pod — and the check runs again: still no container runtime. Then a runner-only release in a
// namespace of its own (issue #1454): its lane pod joins the hopper — as a hopper outside the release, by its URL, with a
// lane pool key the hopper issued, with no restart of the hopper — and shows online and ready, with no host path and no
// host credential. Needs
// `kind`, `helm` and `kubectl` on PATH, and a container runtime for kind.
//
//   node scripts/kind-check.ts [--cluster NAME] [--tag TAG] [--keep] [--set key=value ...]
//
// --cluster names the kind cluster (default hopper-check), --tag the hopper's image tag (default: the chart's), --set
// passes more values to the chart, and --keep keeps the cluster at the end. Exit 0 when the check passes, 1 when not.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CHART = join(import.meta.dirname, '..', 'deploy', 'helm', 'hopper');
const NAMESPACE = 'hopper';
const PORT = 4790;
// The release is named hopper, so the chart's names are too.
const LANE_POD = 'hopper-lanes-0';

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
  if (install(context, ['--create-namespace'], values) !== 0) return 'helm install did not bring up the release';

  return healthy(context) ?? noRuntime(context) ?? migratesOnce(context) ?? keyKept(context) ?? rolloutRestart(context) ?? withoutGitHub(context) ?? machines(context) ?? runnerOnly(context, tag);
}

/** `helm install` of the release, waiting for it, with `values`. Answers its exit status. */
function install(context: string, flags: string[], values: string[]): number | null {
  return sh('helm', ['install', 'hopper', CHART, '--kube-context', context, '--namespace', NAMESPACE, ...flags,
    '--wait', '--wait-for-jobs', '--timeout', '15m', ...values.flatMap((v) => ['--set', v])]).status;
}

/** The hopper's health answers ok, asked on its pod's loopback, as its probes ask: from outside the pod it would be a LAN request. */
function healthy(context: string): string | null {
  const health = `fetch('http://127.0.0.1:${PORT}/api/health').then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))`;
  const h = sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'exec', 'deploy/hopper', '-c', 'hopper', '--', 'node', '-e', health], true);
  let ok = false;
  try { ok = h.status === 0 && (JSON.parse(h.stdout) as { ok?: unknown }).ok === true; } catch { /* not JSON */ }
  if (!ok) return `the hopper's health is not ok: ${h.stdout.trim() || `exit ${h.status}`}`;
  console.log(`health: ${h.stdout.trim()}`);
  return null;
}

/** No pod in the cluster has a container runtime socket or runs a container runtime. */
function noRuntime(context: string, pods?: Pod[]): string | null {
  const all = pods ?? listPods(context);
  if (!all) return 'kubectl could not list the pods';
  const found = findings(all);
  if (found.length > 0) return `a container runtime in the cluster:\n${found.map((f) => `  ${f}`).join('\n')}`;
  console.log(`${all.length} pods, no container runtime socket, no Podman, Docker or compose`);
  return null;
}

function listPods(context: string): Pod[] | null {
  const list = sh('kubectl', ['--context', context, 'get', 'pods', '--all-namespaces', '-o', 'json'], true);
  return list.status === 0 ? (JSON.parse(list.stdout) as { items: Pod[] }).items : null;
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

let fingerprint = '';

// The start's line about the master key (src/secrets/master-key.ts logMasterKey): where it came from, and its fingerprint.
const KEY_LINE = /master key: .*\(([a-z-]+)\), fingerprint ([0-9a-f]+)/;

/**
 * The fingerprint of the master key the hopper's pod runs on, from its log: never the key. Given at launch, never one it
 * made itself. Read from the log, as `hopper master-key status` needs a user, and no one signed in here.
 */
function keyOf(context: string): { fingerprint: string } | { failure: string } {
  const log = sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'logs', 'deploy/hopper', '-c', 'hopper'], true);
  const line = log.stdout.split('\n').map((l) => KEY_LINE.exec(l)).find((m) => m !== null);
  if (log.status !== 0 || !line) return { failure: `the hopper's log names no master key: ${log.status === 0 ? 'no line about it' : `exit ${log.status}`}` };
  if (line[1] !== 'given') return { failure: `the hopper's master key is not given at launch (source ${line[1]}): the chart's Secret did not reach it` };
  return { fingerprint: line[2]! };
}

/** The same key as before, on the hopper's pod as it is now. */
function sameKey(context: string, what: string): string | null {
  const key = keyOf(context);
  if ('failure' in key) return key.failure;
  if (key.fingerprint !== fingerprint) return `${what} runs on the master key of fingerprint ${key.fingerprint}, not ${fingerprint}`;
  return null;
}

/** The hopper's pod deleted, its new pod starts on the same master key: the one the chart made and keeps (issue #1406). */
function keyKept(context: string): string | null {
  const key = keyOf(context);
  if ('failure' in key) return key.failure;
  fingerprint = key.fingerprint;
  const kubectl = (...args: string[]): number | null => sh('kubectl', ['--context', context, '--namespace', NAMESPACE, ...args]).status;
  if (kubectl('delete', 'pod', '-l', 'app.kubernetes.io/instance=hopper,app.kubernetes.io/component=hopper', '--wait=true', '--timeout=5m') !== 0) return 'kubectl could not delete the hopper\'s pod';
  if (kubectl('rollout', 'status', 'deployment/hopper', '--timeout=5m') !== 0) return 'no new hopper pod came up after its pod was deleted';
  const health = healthy(context);
  if (health) return `after its pod was deleted, ${health}`;
  const same = sameKey(context, 'the new hopper pod');
  if (same) return same;
  console.log(`a new hopper pod runs on the same master key (fingerprint ${fingerprint})`);
  return null;
}

/** A default install comes back healthy after `kubectl rollout restart`, on the same master key (issues #1406, #1422). */
function rolloutRestart(context: string): string | null {
  const kubectl = (...args: string[]): number | null => sh('kubectl', ['--context', context, '--namespace', NAMESPACE, ...args]).status;
  if (kubectl('rollout', 'restart', 'deployment/hopper') !== 0) return 'kubectl could not restart the hopper\'s deployment';
  if (kubectl('rollout', 'status', 'deployment/hopper', '--timeout=5m') !== 0) return 'the hopper did not come back after rollout restart';
  const health = healthy(context);
  if (health) return `after rollout restart, ${health}`;
  const same = sameKey(context, 'after rollout restart the hopper');
  if (same) return same;
  console.log(`after rollout restart the hopper is healthy on the same master key (fingerprint ${fingerprint})`);
  return null;
}

/** What each box gets on kind (the chart's `sandbox.limits`): little, as a kind node on a CI runner has little room. */
const BOX_LIMITS = ['sandbox.limits.cpus=0.25', 'sandbox.limits.memoryMb=128'];

// The first admin's local account on the cluster hopper. Its password is made here and goes only on stdin.
const ADMIN = 'admin@example.com';

/**
 * In the hopper's pod, on its loopback (a loopback request, as a person at a port-forward makes): sign in with the local
 * account's email and password (on stdin), mint a read-only grant for an agent, trade its refresh token for a new API
 * token, and read the person's grants with it. Prints what the API token read, as JSON.
 */
const SIGN_IN_AND_GRANT = `
const base = 'http://127.0.0.1:${PORT}';
const json = { 'content-type': 'application/json', origin: base };
const call = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...json, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  if (!r.ok) throw new Error(path + ': ' + r.status + ' ' + text);
  return JSON.parse(text);
};
let password = '';
process.stdin.on('data', (d) => { password += d; }).on('end', async () => {
  try {
    const { token } = await call('/ui/auth/password', { username: '${ADMIN}', password: password.trim() });
    const who = await call('/ui/api/session', undefined, { 'x-hopper-session': token });
    const minted = await call('/ui/api/api-tokens', { action: 'mint', label: 'kind check', holder: 'kind-check', preset: 'read-only' }, { 'x-hopper-session': token });
    const pair = await call('/ui/auth/token/refresh', { refresh: minted.refresh });
    const seen = await call('/api/api-tokens', undefined, { authorization: 'Bearer ' + pair.token });
    process.stdout.write(JSON.stringify({ realm: who.user && who.user.realm, role: who.user && who.user.role, holders: seen.grants.map((g) => g.holder) }));
  } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(1); }
});`;

/** A command in the hopper's container, with `input` on its stdin. */
function inPod(context: string, input: string, ...command: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('kubectl', ['--context', context, '--namespace', NAMESPACE, 'exec', '-i', 'deploy/hopper', '-c', 'hopper', '--', ...command],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '' };
}

/**
 * A person signs in with no GitHub and an agent acts for them (issue #1380): the first admin's local account from the
 * operator CLI in the pod, a sign-in with its email and password, a grant minted for an agent, and the grant's refreshed
 * API token reads that person's grants. The cluster holds no GitHub App and no GitHub connection.
 */
let adminPassword = '';

function withoutGitHub(context: string): string | null {
  const password = randomBytes(18).toString('base64url');
  adminPassword = password;
  const added = inPod(context, `${password}\n`, 'hopper', 'local-account', 'add', ADMIN);
  if (added.status !== 0) return `hopper local-account add in the hopper's pod did not succeed: exit ${added.status}`;
  const r = inPod(context, password, 'node', '-e', SIGN_IN_AND_GRANT);
  let seen: { realm?: string; role?: string; holders?: string[]; error?: string } = {};
  try { seen = JSON.parse(r.stdout) as typeof seen; } catch { /* not JSON */ }
  if (r.status !== 0 || seen.error) return `a sign-in with no GitHub and a grant did not work: ${seen.error ?? (r.stdout.trim() || `exit ${r.status}`)}`;
  if (seen.realm !== 'local-accounts' || seen.role !== 'admin') return `the local account signed in as ${seen.role ?? 'no role'} through ${seen.realm ?? 'no realm'}, not as admin through local-accounts`;
  if (JSON.stringify(seen.holders) !== '["kind-check"]') return `the grant's API token read the grants ${JSON.stringify(seen.holders)}, not the one it was minted with`;
  console.log('a local account signed in with no GitHub, minted a grant, and its refreshed API token read as that person');
  return null;
}

/**
 * The machines as pods: sandbox boxes on (the hopper starts them through the Kubernetes API), and one lane pod. The lane
 * pod joins only once a person signed in, so its upgrade does not wait for it: its spec is what the check reads.
 *
 * They come up by an upgrade of the same release: a new hopper pod on its database starts on the key the chart keeps.
 */
function machines(context: string): string | null {
  const upgrade = (...args: string[]): number | null => sh('helm', ['upgrade', 'hopper', CHART, '--kube-context', context,
    '--namespace', NAMESPACE, '--reuse-values', ...args]).status;
  if (upgrade('--wait', '--wait-for-jobs', '--timeout', '15m', '--set', 'sandbox.enabled=true', ...BOX_LIMITS.flatMap((v) => ['--set', v])) !== 0) return 'helm upgrade with sandbox.enabled=true did not succeed';
  const health = healthy(context);
  if (health) return `with sandbox boxes on, ${health}`;
  const same = sameKey(context, 'with sandbox boxes on, the hopper');
  if (same) return same;
  if (upgrade('--set', 'lanes.replicas=1') !== 0) return 'helm upgrade with lanes.replicas=1 did not succeed';
  sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'wait', '--for=create', `pod/${LANE_POD}`, '--timeout=180s']);
  const pods = listPods(context);
  if (!pods) return 'kubectl could not list the pods';
  if (!pods.some((p) => p.metadata.namespace === NAMESPACE && p.metadata.name === LANE_POD)) return `no lane pod ${LANE_POD} after lanes.replicas=1`;
  const runtime = noRuntime(context, pods);
  if (runtime) return runtime;
  console.log(`machines as pods: sandbox boxes on, lane pod ${LANE_POD}`);
  return null;
}

// The runner-only release (issue #1454): its namespace, its name, and so its lane pod's name.
const RUNNER_NAMESPACE = 'hopper-runner';
const RUNNER_POD = 'runner-hopper-lanes-0';
// The hopper as a hopper outside the release reaches it: a URL, a name the hopper answers to (one of its LAN names).
const HOPPER_URL = `http://hopper.${NAMESPACE}.svc.cluster.local:${PORT}`;

/** In the hopper's pod, signed in as the first admin (password on stdin): the machines, as GET /api/machines answers. */
const READ_MACHINES = `
const base = 'http://127.0.0.1:${PORT}';
let password = '';
process.stdin.on('data', (d) => { password += d; }).on('end', async () => {
  try {
    const h = { 'content-type': 'application/json', origin: base };
    const s = await fetch(base + '/ui/auth/password', { method: 'POST', headers: h, body: JSON.stringify({ username: '${ADMIN}', password: password.trim() }) });
    const { token } = await s.json();
    const r = await fetch(base + '/api/machines', { headers: { ...h, 'x-hopper-session': token } });
    process.stdout.write(JSON.stringify((await r.json()).machines.map((m) => ({ id: m.id, online: m.online, infraCredentials: m.infraCredentials }))));
  } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(1); }
});`;

/** The hopper's pod: its uid and restart count, to know it was not started again. */
function hopperPod(context: string): string {
  return sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'get', 'pods', '-l', 'app.kubernetes.io/instance=hopper,app.kubernetes.io/component=hopper',
    '-o', 'jsonpath={range .items[*]}{.metadata.uid}/{.status.containerStatuses[0].restartCount}{end}'], true).stdout.trim();
}

/**
 * A runner-only release (issue #1454): the lane pods alone, in a namespace of their own, join the hopper by its URL with
 * a lane pool key it issued (`hopper pool-key`), and the hopper does not start again. The machine shows online and ready
 * (no infra credentials on it), and no pod of the release mounts a host path or holds a credential in the jobs'
 * container. A hopper image older than `hopper pool-key` (the dev channel before this change ships) lets no pod join
 * with its install's key (it gives such pods to a user `admin` a fresh hopper does not have): then the check takes
 * that key, does not wait for the join, and checks that the join step runs and tries again without a crash, and the
 * pods' spec. It says so.
 */
function runnerOnly(context: string, tag: string | undefined): string | null {
  const podBefore = hopperPod(context);
  let key = inPod(context, '', 'hopper', 'pool-key').stdout.trim();
  const issued = /^[0-9a-f]{64}$/.test(key);
  if (!issued) {
    console.log('this hopper image issues no lane pool key yet (hopper pool-key): the runner uses the key of the hopper\'s own release, and the check does not wait for the join');
    const b64 = sh('kubectl', ['--context', context, '--namespace', NAMESPACE, 'get', 'secret', 'hopper-lane-pool', '-o', 'jsonpath={.data.key}'], true).stdout.trim();
    key = Buffer.from(b64, 'base64').toString('utf8');
    if (!/^[0-9a-f]{64}$/.test(key)) return 'no lane pool key: neither hopper pool-key nor the Secret hopper-lane-pool gave one';
  }
  const kubectl = (...args: string[]): number | null => sh('kubectl', ['--context', context, ...args]).status;
  if (kubectl('create', 'namespace', RUNNER_NAMESPACE) !== 0) return `kubectl could not make the namespace ${RUNNER_NAMESPACE}`;
  // The manifest on stdin (`-f -`): Node gives a child's stdin as a socket, which /dev/stdin cannot open (ENXIO).
  const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'runner-pool-key' }, type: 'Opaque', stringData: { key } });
  const secret = spawnSync('kubectl', ['--context', context, '--namespace', RUNNER_NAMESPACE, 'create', '-f', '-'],
    { input: manifest, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (secret.status !== 0) return 'kubectl could not make the Secret runner-pool-key';
  const install = sh('helm', ['install', 'runner', CHART, '--kube-context', context, '--namespace', RUNNER_NAMESPACE, ...(issued ? ['--wait', '--timeout', '15m'] : []),
    ...[...(tag ? [`image.tag=${tag}`] : []), 'hopper.enabled=false', 'lanes.replicas=1', `lanes.hopperUrl=${HOPPER_URL}`, 'lanes.existingSecret=runner-pool-key'].flatMap((v) => ['--set', v])]);
  if (install.status !== 0) return 'helm install of the runner-only release did not succeed';
  const ready = issued ? joined(context) : joinRuns(context);
  if (ready) return ready;

  const pods = (listPods(context) ?? []).filter((p) => p.metadata.namespace === RUNNER_NAMESPACE);
  if (pods.length === 0) return `no pod in ${RUNNER_NAMESPACE}`;
  for (const p of pods) {
    if ((p.spec.volumes ?? []).some((v) => v.hostPath)) return `${RUNNER_NAMESPACE}/${p.metadata.name} mounts a host path`;
    for (const c of p.spec.containers) for (const e of c.env ?? []) if (/KEY|TOKEN|SECRET|PASSWORD/.test(e.name)) return `${RUNNER_NAMESPACE}/${p.metadata.name}/${c.name} has the variable ${e.name}`;
  }
  const runtime = noRuntime(context, pods);
  if (runtime) return runtime;
  const podAfter = hopperPod(context);
  if (podAfter !== podBefore) return `the hopper started again while the runner joined: ${podBefore} became ${podAfter}`;
  console.log(issued
    ? `runner-only release: ${RUNNER_POD} joined the hopper at ${HOPPER_URL}, online and ready, no host path, no credential, no hopper restart`
    : `runner-only release: ${RUNNER_POD} tries to join the hopper at ${HOPPER_URL} with no crash, no host path, no credential, no hopper restart`);
  return null;
}

/** The runner's lane pod shows online and ready on the hopper: no infra credentials on it. */
function joined(context: string): string | null {
  let seen: { id: string; online: boolean; infraCredentials?: string[] } | undefined;
  for (let i = 0; i < 60; i++) {
    const r = inPod(context, adminPassword, 'node', '-e', READ_MACHINES);
    try { seen = (JSON.parse(r.stdout) as { id: string; online: boolean; infraCredentials?: string[] }[]).find((m) => m.id === RUNNER_POD); } catch { seen = undefined; }
    if (seen?.online && Array.isArray(seen.infraCredentials)) break;
    spawnSync('sleep', ['5']);
  }
  if (!seen?.online) return `the runner's lane pod ${RUNNER_POD} is not online on the hopper: ${JSON.stringify(seen ?? 'not there')}`;
  if (!Array.isArray(seen.infraCredentials)) return `the hopper did not read the infra credentials of ${RUNNER_POD}: it cannot say it is ready`;
  if (seen.infraCredentials.length > 0) return `${RUNNER_POD} is not ready: it holds the infra credentials ${seen.infraCredentials.join(', ')}`;
  return null;
}

/**
 * The runner's join step runs and tries the join again, with no crash: its home copied into the volume, the join refused
 * for now. Its last lines are printed: they say why the hopper does not let it in.
 */
function joinRuns(context: string): string | null {
  const kubectl = (...args: string[]): { status: number | null; stdout: string } => sh('kubectl', ['--context', context, '--namespace', RUNNER_NAMESPACE, ...args], true);
  if (kubectl('wait', '--for=create', `pod/${RUNNER_POD}`, '--timeout=180s').status !== 0) return `no lane pod ${RUNNER_POD} in ${RUNNER_NAMESPACE}`;
  const state = (): { restarts: number; running: boolean } => {
    const out = kubectl('get', 'pod', RUNNER_POD, '-o', 'jsonpath={.status.initContainerStatuses[0].restartCount} {.status.initContainerStatuses[0].state.running.startedAt}').stdout.trim().split(' ');
    return { restarts: Number(out[0] || 0), running: Boolean(out[1]) };
  };
  let s = state();
  // The box image is large: its pull takes minutes.
  for (let i = 0; i < 180 && !s.running && s.restarts === 0; i++) { spawnSync('sleep', ['5']); s = state(); }
  // Long enough for a join step that fails at once to stop and be started again.
  spawnSync('sleep', ['60']);
  s = state();
  const log = kubectl('logs', RUNNER_POD, '-c', 'join', '--tail', '3').stdout.trim();
  if (log) console.log(`the join step of ${RUNNER_POD} says:\n${log}`);
  if (s.restarts > 0) return `the join step of ${RUNNER_POD} stopped and was started again ${s.restarts} times: it must try the join again, not stop`;
  if (!s.running) return `the join step of ${RUNNER_POD} does not run`;
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
