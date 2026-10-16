// The sandbox part of the kind check (issue #1371, docs/deploy.md "Check the chart on kind"): on the cluster the kind
// check kept (`scripts/kind-check.ts --keep`, sandbox boxes on), need boxes run through the Kubernetes runtime of this
// checkout, as the hopper's own service account, so the chart's sandbox Role is all they get. Each box ends one way —
// it succeeds, fails, times out, or is cancelled — and after each no pod, claim or secret with its labels stays. A later
// box of the same template sees nothing of an earlier one, and two boxes at once see nothing of each other. The runtime
// refuses to remove the hopper's own pod and its Postgres's claim, and the hopper's pods are the same until then. Last,
// the hopper is killed, a need box of its instance runs while it is down, and the hopper started again must remove it
// (`crashAndRestart`). Needs `kubectl` on PATH and this checkout's dependencies (`npm ci`).
//
// Issue #1422 adds, before the restart: each box gets the CPU and memory the chart's `sandbox.limits` give, as the
// kernel holds them; a box that goes over its memory is killed, and its log says so. A box reaches the hopper and nothing
// else: not another box, not a Service of the release (the hopper's database, OpenFGA), not the Kubernetes API, not its
// node; it holds no service account token and only the credential its step was given. Then dozens of steps at once go
// through the sandbox module (src/sandbox/service.ts): more than the nodes have room for, so some wait for the scheduler,
// and all run, give back their outputs and leave nothing; no box is a lane pod or takes a client's link, and the
// module's ledger holds no open run after. The hopper's memory before and after the burst is printed, never asserted:
// load numbers run locally.
//
//   node scripts/kind-sandbox-check.ts [--context CONTEXT] [--namespace NAMESPACE] [--image IMAGE] [--node-reach]
//
// --context names the kube context (default kind-hopper-check), --namespace the release's (default hopper), --image the
// boxes' image (default busybox: any image with sh, tar and base64), and --node-reach, on a cluster whose network
// plugin lets a pod reach its own node, says what a box reaches there and the API server instead of failing on it. Exit 0 when the check passes, 1 when not.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { HOME } from '../src/sandbox/flags.ts';
import { createKubeApi } from '../src/sandbox/kubernetes-api.ts';
import { createKubernetesRuntime, POD_LABEL } from '../src/sandbox/kubernetes.ts';
import { needEnv, NEED_LABEL, runNeedBox, type NeedBoxResult } from '../src/sandbox/need-box.ts';
import type { ContainerRuntime, ResourceLimits } from '../src/domain/sandboxes.ts';
import { boxLimitsOf, burst, gone, GONE_MS, held, isolation, killedForMemory, MIB, must, PORT, type Kubectl } from './kind-sandbox-cases.ts';

export type { Kubectl };

/** The environment kubectl runs in: the person's, whatever KUBECONFIG the runtime is later given. */
const PERSON = { ...process.env };
function kubectl(context: string, args: string[]): ReturnType<Kubectl> {
  const r = spawnSync('kubectl', ['--context', context, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: PERSON });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : r.stderr };
}

/**
 * A kubeconfig of the hopper's service account in the release's namespace: the cluster as the context names it, and a
 * token the API mints for the account for an hour. What the runtime does here, the hopper's Role lets it do.
 */
function serviceAccountConfig(k: Kubectl, context: string, namespace: string, account: string, file: string): void {
  const view = JSON.parse(must((args) => kubectl(context, args), ['config', 'view', '--raw', '--minify', '-o', 'json'])) as {
    clusters: { name: string; cluster: Record<string, unknown> }[];
  };
  const cluster = view.clusters[0];
  if (!cluster) throw new Error(`the context ${context} names no cluster`);
  const token = must(k, ['create', 'token', account, '--duration', '1h']).trim();
  writeFileSync(file, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'hopper',
    clusters: [{ name: 'kind', cluster: cluster.cluster }],
    users: [{ name: 'hopper', user: { token } }],
    contexts: [{ name: 'hopper', context: { cluster: 'kind', user: 'hopper', namespace } }],
  }), { mode: 0o600 });
}

interface Named { metadata: { name: string; uid: string; labels?: Record<string, string>; deletionTimestamp?: string } }

interface Run { name: string; script: string; timeoutMs?: number; cancelOn?: string; expect(r: NeedBoxResult, log: string): string | null }

/** One need box run to its end, as a step runs it; then nothing with its labels may be left. Answers what failed, or null. */
async function oneBox(o: { runtime: ContainerRuntime; k: Kubectl; image: string; instance: string; dir: string }, run: Run): Promise<string | null> {
  const stop = new AbortController();
  let log = '';
  const result = await runNeedBox(o.runtime, {
    name: `hopper-need-kind-${run.name}-${randomBytes(3).toString('hex')}`, userId: 'kind-check', instanceId: o.instance, network: 'unused',
    template: { image: o.image }, env: { ...needEnv({ command: run.script, outputs: [], credentials: [] }), HOME },
    timeoutMs: run.timeoutMs ?? 300_000, dir: o.dir,
  }, {
    signal: stop.signal,
    log(chunk) {
      log += chunk;
      if (run.cancelOn && log.includes(run.cancelOn)) stop.abort();
    },
  });
  const wrong = run.expect(result, log);
  if (wrong) return `${run.name}: ${wrong} (exit ${result.exit}${result.problem ? `, ${result.problem}` : ''}; log: ${log.trim() || 'none'})`;
  const left = await gone(o.k, o.instance);
  if (left.length > 0) return `${run.name}: left after the box ended: ${left.join(', ')}`;
  console.log(`${run.name}: exit ${result.exit}${result.problem ? ` (${result.problem})` : ''}; nothing with its labels left`);
  return null;
}

const exits = (code: number) => (r: NeedBoxResult): string | null => (r.exit === code && !r.problem ? null : `it should end with exit ${code}`);
const problem = (text: string) => (r: NeedBoxResult): string | null => (r.exit === 125 && r.problem?.includes(text) ? null : `it should end with "${text}"`);
/** The check. Answers what failed, or null. */
export async function check(context: string, namespace: string, image: string, nodeReach = false): Promise<string | null> {
  const k: Kubectl = (args) => kubectl(context, ['--namespace', namespace, ...args]);
  const deployment = JSON.parse(must(k, ['get', 'deployment', 'hopper', '-o', 'json'])) as {
    spec: { selector: { matchLabels: Record<string, string> }; template: { spec: { serviceAccountName?: string; containers: { name: string; env?: { name: string; value?: string }[] }[] } } };
  };
  const limits = boxLimitsOf(deployment.spec.template.spec.containers.find((c) => c.name === 'hopper')?.env ?? []);
  if (typeof limits === 'string') return limits;
  const account = deployment.spec.template.spec.serviceAccountName ?? 'default';
  const own = (): Named[] => (JSON.parse(must(k, ['get', 'pods', '-o', 'json'])) as { items: Named[] }).items
    .filter((p) => p.metadata.labels?.[POD_LABEL] === undefined);
  const before = own();
  const hopperPod = before.find((p) => Object.entries(deployment.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v));
  if (!hopperPod) return 'no pod of the hopper\'s deployment';
  const claims = (JSON.parse(must(k, ['get', 'persistentvolumeclaims', '-o', 'json'])) as { items: Named[] }).items
    .filter((c) => c.metadata.labels?.[POD_LABEL] === undefined);

  const dir = mkdtempSync(join(tmpdir(), 'hopper-kind-sandbox-'));
  try {
    // Written with the person's kubeconfig; only then is it the one the runtime's API client reads.
    const config = join(dir, 'kubeconfig');
    serviceAccountConfig(k, context, namespace, account, config);
    process.env.KUBECONFIG = config;
    const { api } = createKubeApi(namespace);
    // As the hopper makes it: a need box asks for 4 CPUs and 8 GiB, and the chart's limits cap that (issue #1422).
    const runtime = createKubernetesRuntime({ api, hopper: { namespace, labels: deployment.spec.selector.matchLabels, port: PORT }, most: limits });
    const instance = `kind-${randomBytes(4).toString('hex')}`;
    const box = { runtime, k, image, instance, dir };

    const runs: Run[] = [
      { name: 'succeeds', script: 'echo marker > "$HOME/marker" && echo marker > marker && echo written', expect: exits(0) },
      // The same template, after it: neither the home's marker nor the work directory's.
      { name: 'later', script: 'test ! -e "$HOME/marker" && test ! -e marker && echo fresh', expect: exits(0) },
      { name: 'fails', script: 'echo marker > "$HOME/marker"; exit 3', expect: exits(3) },
      { name: 'times-out', script: 'echo started; sleep 600', timeoutMs: 60_000, expect: problem('did not end') },
      { name: 'cancelled', script: 'echo started; sleep 600', cancelOn: 'started', expect: problem('stopped waiting') },
      // Issue #1422: the chart's limits, as the kernel holds them; over its memory, a box is killed and says so.
      { name: 'limits', script: 'echo "memory.max $(cat /sys/fs/cgroup/memory.max)"; echo "cpu.max $(cat /sys/fs/cgroup/cpu.max)"', expect: held(limits) },
      { name: 'over-memory', script: `x=$(head -c ${limits.memoryMb * 4 * MIB} /dev/zero | tr '\\000' a); echo "kept ${'$'}{#x} bytes"`, expect: killedForMemory },
    ];
    for (const run of runs) {
      const failed = await oneBox(box, run);
      if (failed) return failed;
    }

    // Two at once, of the same template: each writes its own file and never sees the other's.
    const pair = await Promise.all(['a', 'b'].map((me) => {
      const them = me === 'a' ? 'b' : 'a';
      return oneBox(box, { name: `together-${me}`, script: `echo ${me} > "$HOME/${me}" && sleep 20 && test ! -e "$HOME/${them}" && echo alone`, expect: exits(0) });
    }));
    const together = pair.find((f) => f !== null);
    if (together) return together;

    const reach = await isolation({ ...box, namespace, hopperService: 'hopper', nodeReach });
    if (reach) return reach;
    const many = await burst({ ...box, limits, context, namespace });
    if (many) return many;

    // The runtime removes only its own: the hopper's pod and its Postgres's claim are refused.
    const refused = async (what: string, call: () => Promise<void>): Promise<string | null> => {
      try {
        await call();
        return `the runtime removed ${what}`;
      } catch (e) {
        return (e as Error).message.includes('carries no sandbox label') ? null : `removing ${what}: ${(e as Error).message}`;
      }
    };
    const pod = await refused(`the hopper's pod ${hopperPod.metadata.name}`, () => runtime.remove(hopperPod.metadata.name));
    if (pod) return pod;
    for (const c of claims) {
      const claim = await refused(`the claim ${c.metadata.name}`, () => runtime.removeVolume(c.metadata.name));
      if (claim) return claim;
    }
    console.log(`the runtime refused the hopper's pod and ${claims.length} claims of the release`);

    const after = own();
    const changed = before.filter((p) => !after.some((a) => a.metadata.uid === p.metadata.uid && !a.metadata.deletionTimestamp));
    if (changed.length > 0) return `pods of the release went: ${changed.map((p) => p.metadata.name).join(', ')}`;
    console.log(`the release's ${before.length} pods are as they were`);

    // Last, as it replaces the hopper's pod.
    return await crashAndRestart({ kubectl: k, runtime, image, selector: deployment.spec.selector.matchLabels, limits });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Kill and start again (issue #1371, part 5): the hopper is stopped at once, with no grace, and while it is down a need
 * box of its own instance runs, as a step it started and never ended leaves one. Then the hopper starts again, and its
 * first sweep must remove the box and its home: no pod, claim or secret with the box's labels may stay. The box is made
 * while the hopper is down, so only the restarted hopper can have removed it. Answers what failed, or null.
 */
export async function crashAndRestart(o: {
  kubectl: Kubectl; runtime: ContainerRuntime; image: string; selector: Record<string, string>; limits?: ResourceLimits; goneMs?: number; pollMs?: number;
}): Promise<string | null> {
  const k = o.kubectl;
  const read = k(['exec', 'statefulset/hopper-postgres', '-c', 'postgres', '--', 'psql', '-U', 'hopper', '-d', 'hopper', '-tAc',
    "SELECT value FROM settings WHERE key = 'instanceId'"]);
  const instance = read.stdout.trim();
  if (read.status !== 0 || !/^[0-9a-f]{16}$/.test(instance)) return `cannot read the hopper's instance id: ${read.stderr.trim() || instance || `exit ${read.status}`}`;
  const selector = Object.entries(o.selector).map(([key, v]) => `${key}=${v}`).join(',');

  must(k, ['scale', 'deployment/hopper', '--replicas=0']);
  must(k, ['delete', 'pod', '-l', selector, '--grace-period=0', '--force', '--ignore-not-found']);
  const down = Date.now() + (o.goneMs ?? GONE_MS);
  while (must(k, ['get', 'pods', '-l', selector, '-o', 'name']).trim() !== '') {
    if (Date.now() >= down) return 'the hopper\'s pod did not go';
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2_000));
  }

  const name = `hopper-need-kind-orphan-${randomBytes(3).toString('hex')}`;
  const volume = `${name}-home`;
  const labels = { [NEED_LABEL]: instance };
  if (!(await o.runtime.createVolume(volume, labels))) return `the home ${volume} was there already`;
  const { user } = await o.runtime.pull(o.image);
  const id = await o.runtime.create({ name, image: o.image, network: 'unused', volume, labels, user, env: { HOME }, limits: o.limits ?? { cpus: 0.25, memoryMb: 128 }, script: 'sleep 3600' });
  await o.runtime.start(id);
  const state = (await o.runtime.inspect(id))?.state;
  if (state !== 'running') return `the box ${name} the hopper leaves is ${state ?? 'gone'}, not running, while the hopper is down`;
  console.log(`the hopper is down; its need box ${name} runs`);

  must(k, ['scale', 'deployment/hopper', '--replicas=1']);
  must(k, ['rollout', 'status', 'deployment/hopper', '--timeout=10m']);
  const left = await gone(k, instance, o.goneMs, o.pollMs);
  if (left.length > 0) return `left after the hopper started again: ${left.join(', ')}`;
  console.log(`the hopper started again and removed the box ${name} and its home`);
  return null;
}

if (import.meta.main) {
  const { values: opts } = parseArgs({
    options: {
      context: { type: 'string', default: 'kind-hopper-check' },
      namespace: { type: 'string', default: 'hopper' },
      image: { type: 'string', default: 'docker.io/library/busybox:1.37' },
      'node-reach': { type: 'boolean', default: false },
    },
  });
  let failure: string | null;
  try {
    failure = await check(opts.context, opts.namespace, opts.image, opts['node-reach']);
  } catch (e) {
    failure = (e as Error).message;
  }
  if (failure) {
    console.log(kubectl(opts.context, ['get', 'pods,persistentvolumeclaims', '--all-namespaces', '-o', 'wide']).stdout);
    console.error(`kind sandbox check failed: ${failure}`);
    process.exit(1);
  }
  console.log('kind sandbox check passed');
}
