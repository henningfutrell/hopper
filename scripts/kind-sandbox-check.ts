// The sandbox part of the kind check (issue #1371, docs/deploy.md "Check the chart on kind"): on the cluster the kind
// check kept (`scripts/kind-check.ts --keep`, sandbox boxes on), need boxes run through the Kubernetes runtime of this
// checkout, as the hopper's own service account, so the chart's sandbox Role is all they get. Each box ends one way —
// it succeeds, fails, times out, or is cancelled — and after each no pod, claim or secret with its labels stays. A later
// box of the same template sees nothing of an earlier one, and two boxes at once see nothing of each other. The runtime
// refuses to remove the hopper's own pod and its Postgres's claim, and the hopper's pods are the same at the end. Needs
// `kubectl` on PATH and this checkout's dependencies (`npm ci`).
//
//   node scripts/kind-sandbox-check.ts [--context CONTEXT] [--namespace NAMESPACE] [--image IMAGE]
//
// --context names the kube context (default kind-hopper-check), --namespace the release's (default hopper), --image the
// boxes' image (default busybox: any image with sh, tar and base64). Exit 0 when the check passes, 1 when not.
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
import type { ContainerRuntime } from '../src/domain/sandboxes.ts';

const PORT = 4790;
/** The environment kubectl runs in: the person's, whatever KUBECONFIG the runtime is later given. */
const PERSON = { ...process.env };
/** How long a box's pod and claim may take to go once its run ended: a pod's grace, then the claim's protection. */
const GONE_MS = 180_000;

function kubectl(context: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['--context', context, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: PERSON });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : r.stderr };
}

function must(context: string, args: string[]): string {
  const r = kubectl(context, args);
  if (r.status !== 0) throw new Error(`kubectl ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/**
 * A kubeconfig of the hopper's service account in the release's namespace: the cluster as the context names it, and a
 * token the API mints for the account for an hour. What the runtime does here, the hopper's Role lets it do.
 */
function serviceAccountConfig(context: string, namespace: string, account: string, file: string): void {
  const view = JSON.parse(must(context, ['config', 'view', '--raw', '--minify', '-o', 'json'])) as {
    clusters: { name: string; cluster: Record<string, unknown> }[];
  };
  const cluster = view.clusters[0];
  if (!cluster) throw new Error(`the context ${context} names no cluster`);
  const token = must(context, ['--namespace', namespace, 'create', 'token', account, '--duration', '1h']).trim();
  writeFileSync(file, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'hopper',
    clusters: [{ name: 'kind', cluster: cluster.cluster }],
    users: [{ name: 'hopper', user: { token } }],
    contexts: [{ name: 'hopper', context: { cluster: 'kind', user: 'hopper', namespace } }],
  }), { mode: 0o600 });
}

interface Named { metadata: { name: string; uid: string; labels?: Record<string, string>; deletionTimestamp?: string } }

/** The pods, claims and secrets in the namespace that carry the need label of `instance`: none, once its box is gone. */
function leftOf(context: string, namespace: string, instance: string): string[] {
  return must(context, ['--namespace', namespace, 'get', 'pods,persistentvolumeclaims,secrets', '-l', `${NEED_LABEL}=${instance}`, '-o', 'name'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Waits until nothing with the need label of `instance` is left; answers what is left at the end. */
async function gone(context: string, namespace: string, instance: string): Promise<string[]> {
  const end = Date.now() + GONE_MS;
  for (;;) {
    const left = leftOf(context, namespace, instance);
    if (left.length === 0 || Date.now() >= end) return left;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

interface Run { name: string; script: string; timeoutMs?: number; cancelOn?: string; expect(r: NeedBoxResult): string | null }

/** One need box run to its end, as a step runs it; then nothing with its labels may be left. Answers what failed, or null. */
async function oneBox(o: { runtime: ContainerRuntime; context: string; namespace: string; image: string; instance: string; dir: string }, run: Run): Promise<string | null> {
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
  const wrong = run.expect(result);
  if (wrong) return `${run.name}: ${wrong} (exit ${result.exit}${result.problem ? `, ${result.problem}` : ''}; log: ${log.trim() || 'none'})`;
  const left = await gone(o.context, o.namespace, o.instance);
  if (left.length > 0) return `${run.name}: left after the box ended: ${left.join(', ')}`;
  console.log(`${run.name}: exit ${result.exit}${result.problem ? ` (${result.problem})` : ''}; nothing with its labels left`);
  return null;
}

const exits = (code: number) => (r: NeedBoxResult): string | null => (r.exit === code && !r.problem ? null : `it should end with exit ${code}`);
const problem = (text: string) => (r: NeedBoxResult): string | null => (r.exit === 125 && r.problem?.includes(text) ? null : `it should end with "${text}"`);

/** The check. Answers what failed, or null. */
export async function check(context: string, namespace: string, image: string): Promise<string | null> {
  const deployment = JSON.parse(must(context, ['--namespace', namespace, 'get', 'deployment', 'hopper', '-o', 'json'])) as {
    spec: { selector: { matchLabels: Record<string, string> }; template: { spec: { serviceAccountName?: string } } };
  };
  const account = deployment.spec.template.spec.serviceAccountName ?? 'default';
  const own = (): Named[] => (JSON.parse(must(context, ['--namespace', namespace, 'get', 'pods', '-o', 'json'])) as { items: Named[] }).items
    .filter((p) => p.metadata.labels?.[POD_LABEL] === undefined);
  const before = own();
  const hopperPod = before.find((p) => Object.entries(deployment.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v));
  if (!hopperPod) return 'no pod of the hopper\'s deployment';
  const claims = (JSON.parse(must(context, ['--namespace', namespace, 'get', 'persistentvolumeclaims', '-o', 'json'])) as { items: Named[] }).items
    .filter((c) => c.metadata.labels?.[POD_LABEL] === undefined);

  const dir = mkdtempSync(join(tmpdir(), 'hopper-kind-sandbox-'));
  try {
    // Written with the person's kubeconfig; only then is it the one the runtime's API client reads.
    const config = join(dir, 'kubeconfig');
    serviceAccountConfig(context, namespace, account, config);
    process.env.KUBECONFIG = config;
    const { api } = createKubeApi(namespace);
    const runtime = createKubernetesRuntime({ api, hopper: { namespace, labels: deployment.spec.selector.matchLabels, port: PORT } });
    const instance = `kind-${randomBytes(4).toString('hex')}`;
    const box = { runtime, context, namespace, image, instance, dir };

    const runs: Run[] = [
      { name: 'succeeds', script: 'echo marker > "$HOME/marker" && echo marker > marker && echo written', expect: exits(0) },
      // The same template, after it: neither the home's marker nor the work directory's.
      { name: 'later', script: 'test ! -e "$HOME/marker" && test ! -e marker && echo fresh', expect: exits(0) },
      { name: 'fails', script: 'echo marker > "$HOME/marker"; exit 3', expect: exits(3) },
      { name: 'times-out', script: 'echo started; sleep 600', timeoutMs: 60_000, expect: problem('did not end') },
      { name: 'cancelled', script: 'echo started; sleep 600', cancelOn: 'started', expect: problem('stopped waiting') },
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const after = own();
  const changed = before.filter((p) => !after.some((a) => a.metadata.uid === p.metadata.uid && !a.metadata.deletionTimestamp));
  if (changed.length > 0) return `pods of the release went: ${changed.map((p) => p.metadata.name).join(', ')}`;
  console.log(`the release's ${before.length} pods are as they were`);
  return null;
}

if (import.meta.main) {
  const { values: opts } = parseArgs({
    options: {
      context: { type: 'string', default: 'kind-hopper-check' },
      namespace: { type: 'string', default: 'hopper' },
      image: { type: 'string', default: 'docker.io/library/busybox:1.37' },
    },
  });
  let failure: string | null;
  try {
    failure = await check(opts.context, opts.namespace, opts.image);
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
