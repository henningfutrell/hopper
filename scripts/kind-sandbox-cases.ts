// The cases of the kind sandbox check (scripts/kind-sandbox-check.ts) that issue #1422 adds, and the steps they share
// with it: what a box gets (the chart's limits, as the kernel holds them), what it reaches (the hopper alone), and many
// at once through the sandbox module. The steps that read what the cluster says are pure, so they are tested with no
// cluster (test/scripts/kind-sandbox-check.test.ts).
import { randomBytes } from 'node:crypto';
import type { ContainerRuntime, ResourceLimits } from '../src/domain/sandboxes.ts';
import { HOME, KUBERNETES_CONTAINER } from '../src/sandbox/flags.ts';
import { kubeName } from '../src/sandbox/kubernetes.ts';
import { needEnv, NEED_LABEL, runNeedBox, type NeedBoxResult, type NeedCredential } from '../src/sandbox/need-box.ts';
import { createSandboxes } from '../src/sandbox/service.ts';
import { SANDBOX_SETTINGS } from '../src/sandbox/settings.ts';
import { memorySandboxRuns } from '../test/support/sandbox-runs.ts';

/** The hopper's port. */
export const PORT = 4790;
/** How long a box's pod and claim may take to go once its run ended: a pod's grace, then the claim's protection. */
export const GONE_MS = 180_000;
/** The user the check's steps run for: no person, so no machine or lane of anyone's. */
const USER = 'kind-check';
export const MIB = 1024 * 1024;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** kubectl in one context: its exit status and what it wrote. */
export type Kubectl = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** kubectl's output; it throws when kubectl fails. */
export function must(k: Kubectl, args: string[]): string {
  const r = k(args);
  if (r.status !== 0) throw new Error(`kubectl ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** The pods, claims and secrets in the namespace that carry the need label of `instance`: none, once its box is gone. */
function leftOf(k: Kubectl, instance: string): string[] {
  return must(k, ['get', 'pods,persistentvolumeclaims,secrets', '-l', `${NEED_LABEL}=${instance}`, '-o', 'name'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Waits until nothing with the need label of `instance` is left; answers what is left at the end. */
export async function gone(k: Kubectl, instance: string, ms = GONE_MS, pollMs = 2_000): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    const left = leftOf(k, instance);
    if (left.length === 0 || Date.now() >= end) return left;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** The kernel holds the box to the chart's limits: its cgroup's memory.max and cpu.max (cgroup v2). */
export const held = (l: ResourceLimits) => (r: NeedBoxResult, log: string): string | null => {
  if (r.exit !== 0 || r.problem) return 'it should end with exit 0';
  const memory = /memory\.max (\d+)/.exec(log)?.[1], cpu = /cpu\.max (\d+) (\d+)/.exec(log);
  if (Number(memory) !== l.memoryMb * MIB) return `its memory.max is ${memory ?? 'not read'}, not ${l.memoryMb * MIB} (${l.memoryMb} MiB)`;
  if (!cpu || Math.abs(Number(cpu[1]) / Number(cpu[2]) - l.cpus) > 0.01) return `its cpu.max is ${cpu ? `${cpu[1]} ${cpu[2]}` : 'not read'}, not ${l.cpus} CPUs`;
  return null;
};
/** Killed for its memory, and its log says so (the Kubernetes runtime's last line). */
export const killedForMemory = (r: NeedBoxResult, log: string): string | null =>
  (r.exit === 137 && log.includes('OOMKilled') ? null : 'it should be killed for its memory (exit 137), and its log should say OOMKilled');

/** The most CPU and memory the chart gives each box: the env it set on the hopper, read as the hopper reads it. */
export function boxLimitsOf(env: readonly { name: string; value?: string }[]): ResourceLimits | string {
  const of = (name: string): string | undefined => env.find((e) => e.name === name)?.value;
  const cpus = SANDBOX_SETTINGS.HOPPER_KUBERNETES_BOX_CPUS.safeParse(of('HOPPER_KUBERNETES_BOX_CPUS')).data;
  const memoryMb = SANDBOX_SETTINGS.HOPPER_KUBERNETES_BOX_MEMORY_MB.safeParse(of('HOPPER_KUBERNETES_BOX_MEMORY_MB')).data;
  if (cpus === undefined) return 'the chart gives the boxes no CPU limit: install with sandbox.limits.cpus (scripts/kind-check.ts does)';
  if (memoryMb === undefined) return 'the chart gives the boxes no memory limit: install with sandbox.limits.memoryMb (scripts/kind-check.ts does)';
  return { cpus, memoryMb };
}

/** A CPU quantity of Kubernetes (`2`, `1500m`) in CPUs. */
const cpuOf = (q: string | undefined): number => (q === undefined ? 0 : q.endsWith('m') ? Number(q.slice(0, -1)) / 1000 : Number(q));

interface NodeCpu { status?: { allocatable?: Record<string, string> } }
interface PodCpu { status?: { phase?: string }; spec?: { containers?: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[] } }

/** The CPUs the nodes still have room for: what they can give, less what each pod that has not ended asks. */
export function freeCpu(nodes: readonly NodeCpu[], pods: readonly PodCpu[]): number {
  const room = nodes.reduce((n, x) => n + cpuOf(x.status?.allocatable?.cpu), 0);
  const asked = pods.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
    .flatMap((p) => p.spec?.containers ?? []).reduce((n, c) => n + cpuOf(c.resources?.requests?.cpu ?? c.resources?.limits?.cpu), 0);
  return room - asked;
}

/** How many steps the burst asks for at once: dozens, and more than the nodes have room for, so some must wait. */
export const burstSize = (free: number, cpus: number): number => Math.min(64, Math.max(24, Math.floor(free / cpus) + 6));

interface Scheduled { metadata?: { name?: string }; status?: { phase?: string; conditions?: { type: string; status: string; reason?: string }[] } }

/** The pods the scheduler has no room for yet: they wait, queued. */
export const unscheduled = (pods: readonly Scheduled[]): string[] => pods
  .filter((p) => p.status?.phase === 'Pending' && p.status.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'False'))
  .map((p) => p.metadata?.name ?? '');

/** A probe: a name and the URL a box asks. */
export interface Probe { name: string; url: string }

/** The box's script: each URL asked once, at most 5 s, and what wget said, one line each. */
export const probeScript = (probes: readonly Probe[]): string => probes
  .map((p) => `printf 'PROBE %s: %s\\n' '${p.name}' "$(wget -q -T 5 -O /dev/null '${p.url}' 2>&1 && echo ok)"`).join('\n');

/** What the box could not connect to: no answer in time, a refusal, no route. Anything else connected. */
const BLOCKED = /timed out|Connection refused|unreachable|No route to host|bad address/i;

/** Each probe's result: blocked when wget could not connect, else reached. An answer it cannot read counts as reached. */
export function readProbes(log: string): Record<string, 'reached' | 'blocked'> {
  const out: Record<string, 'reached' | 'blocked'> = {};
  for (const m of log.matchAll(/^PROBE ([^:]+): (.*?)\r?$/gm)) out[m[1]!] = BLOCKED.test(m[2]!) ? 'blocked' : 'reached';
  return out;
}

/**
 * The box reached `allowed` and nothing else but the `known` (its node, the API server on it: docs/deploy.md "Sandbox
 * boxes on Kubernetes", Egress). Reaching nothing proves nothing: its network may be down.
 */
export function isolated(probes: Record<string, 'reached' | 'blocked'>, allowed: string, known: readonly string[] = []): string | null {
  if (probes[allowed] !== 'reached') return `the box did not reach the ${allowed}, which its egress policy lets it reach: the probes prove nothing`;
  const reached = Object.entries(probes).filter(([n, r]) => n !== allowed && !known.includes(n) && r === 'reached').map(([n]) => n);
  return reached.length > 0 ? `the box reached ${reached.join(', ')}` : null;
}

export interface Box { runtime: ContainerRuntime; k: Kubectl; image: string; instance: string; dir: string }

/**
 * Isolation (issue #1422): a box reaches the hopper and nothing else. Another box listens on 8080; a second box asks it
 * and every Service of the release but the hopper's (its database, OpenFGA, …), each by what it answers or not. It holds
 * no service account token, and its step's credential only in its file, never in its environment. Its node and the
 * Kubernetes API are asked too: kind's network plugin holds a pod off its own node, which not every plugin does
 * (docs/deploy.md "Sandbox boxes on Kubernetes", Egress), so `--node-reach` makes those two said, not asserted.
 * Answers what failed, or null.
 */
export async function isolation(o: Box & { namespace: string; hopperService: string; nodeReach?: boolean }): Promise<string | null> {
  const k = o.k;
  const listener = `hopper-need-kind-listener-${randomBytes(3).toString('hex')}`;
  const stop = new AbortController();
  const listening = runNeedBox(o.runtime, {
    name: listener, userId: USER, instanceId: o.instance, network: 'unused', template: { image: o.image },
    env: { ...needEnv({ command: 'echo up > /tmp/index.html && exec httpd -f -p 8080 -h /tmp', outputs: [], credentials: [] }), HOME }, timeoutMs: 900_000, dir: o.dir,
  }, { signal: stop.signal, log() {} });
  try {
    // It listens: asked from inside its own pod, so a block later is the policy's, not a box that never listened.
    const pod = kubeName(listener);
    let ip = '';
    for (let n = 0; ; n++) {
      ip = k(['get', 'pod', pod, '-o', 'jsonpath={.status.podIP}']).stdout.trim();
      if (ip && k(['exec', pod, '-c', KUBERNETES_CONTAINER, '--', 'wget', '-q', '-T', '3', '-O', '/dev/null', 'http://127.0.0.1:8080/']).status === 0) break;
      if (n >= 300) return `the listening box ${listener} did not listen on 8080`;
      await sleep(2_000);
    }
    const services = (JSON.parse(must(k, ['get', 'services', '-o', 'json'])) as { items: { metadata: { name: string }; spec: { ports?: { port: number }[] } }[] }).items
      .filter((s) => s.metadata.name !== o.hopperService && (s.spec.ports?.length ?? 0) > 0);
    const api = must(k, ['get', 'service', 'kubernetes', '--namespace', 'default', '-o', 'jsonpath={.spec.clusterIP}']).trim();
    const node = (JSON.parse(must(k, ['get', 'nodes', '-o', 'json'])) as { items: { status: { addresses: { type: string; address: string }[] } }[] }).items[0]
      ?.status.addresses.find((a) => a.type === 'InternalIP')?.address;
    const probes: Probe[] = [
      { name: 'hopper', url: `http://${o.hopperService}:${PORT}/api/health` },
      { name: 'another box', url: `http://${ip}:8080/` },
      ...services.map((s) => ({ name: `service ${s.metadata.name}`, url: `http://${s.metadata.name}:${s.spec.ports![0]!.port}/` })),
      { name: 'the Kubernetes API', url: `http://${api}:443/` },
      ...(node ? [{ name: 'its node', url: `http://${node}:10250/` }] : []),
    ];
    // A credential for its step alone: in its file, never in its environment, and no service account token.
    const token = `kind-check-${randomBytes(8).toString('hex')}`;
    const credential = {
      profile: { operation: 'plan', asset: { kind: 'cluster', name: 'kind-check' } },
      minted: { kind: 'kube', token, expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
      reach: { kind: 'kube', server: 'https://kubernetes.invalid' },
    } as unknown as NeedCredential;
    const secrets = [
      'test -e /var/run/secrets/kubernetes.io/serviceaccount/token && echo "SECRET a service account token" || true',
      'env | grep -q kind-check- && echo "SECRET the credential in its environment" || true',
      'grep -q kind-check- "$HOME/.kube/config" || echo "SECRET no credential in its file"',
      'env | cut -d= -f1 | grep -E "^(HOPPER_STEP_|AWS_|PG|DATABASE)|TOKEN|SECRET|PASSWORD" | sed "s/^/SECRET a variable /" || true',
    ].join('\n');
    let log = '';
    const r = await runNeedBox(o.runtime, {
      name: `hopper-need-kind-probe-${randomBytes(3).toString('hex')}`, userId: USER, instanceId: o.instance, network: 'unused', template: { image: o.image },
      env: { ...needEnv({ command: `${probeScript(probes)}\n${secrets}`, outputs: [], credentials: [credential] }), HOME }, timeoutMs: 300_000, dir: o.dir,
    }, { signal: new AbortController().signal, log(chunk) { log += chunk; } });
    if (r.exit !== 0 || r.problem) return `isolation: the probing box ended with exit ${r.exit}${r.problem ? `, ${r.problem}` : ''}; log: ${log.trim() || 'none'}`;
    const got = readProbes(log);
    const missing = probes.filter((p) => got[p.name] === undefined).map((p) => p.name);
    if (missing.length > 0) return `isolation: no answer for ${missing.join(', ')}; log: ${log.trim()}`;
    const known = o.nodeReach ? ['the Kubernetes API', 'its node'] : [];
    const reach = isolated(got, 'hopper', known);
    if (reach) return `isolation: ${reach}; log: ${log.trim()}`;
    const held = [...log.matchAll(/^SECRET (.*?)\r?$/gm)].map((m) => m[1]);
    if (held.length > 0) return `isolation: the box holds ${held.join('; ')}`;
    if (log.includes(token)) return 'isolation: the box\'s log shows its credential';
    console.log(`isolation: a box reached the hopper, and not ${probes.filter((p) => p.name !== 'hopper' && !known.includes(p.name)).map((p) => p.name).join(', ')}; no token, its credential only in its file`);
    if (known.length > 0) console.log(`isolation, said only: ${known.map((n) => `${n} ${got[n] ?? 'not asked'}`).join(', ')}`);
  } finally {
    stop.abort();
    await listening;
  }
  const left = await gone(k, o.instance);
  return left.length > 0 ? `isolation: left after the boxes ended: ${left.join(', ')}` : null;
}

/** The hopper's resident memory in its pod, as the kernel counts it: for the person to read, never asserted. */
function hopperMemory(k: Kubectl): string {
  const r = k(['exec', 'deploy/hopper', '-c', 'hopper', '--', 'cat', '/proc/1/status']);
  return /VmRSS:\s*(\d+ kB)/.exec(r.stdout)?.[1] ?? 'not read';
}

/**
 * Many at once (issue #1422): dozens of need steps through the sandbox module at once, more than the nodes have room for.
 * The ones with no room wait for the scheduler, queued, never refused; each runs and gives back its own output; then
 * nothing with their labels is left, the module's ledger holds no open run and its view no problem. No box is a lane pod
 * or takes a client's link: none is a machine. Answers what failed, or null.
 */
export async function burst(o: Box & { limits: ResourceLimits; context: string; namespace: string }): Promise<string | null> {
  const k = o.k;
  const free = freeCpu(
    (JSON.parse(must(k, ['get', 'nodes', '-o', 'json'])) as { items: NodeCpu[] }).items,
    (JSON.parse(must(k, ['get', 'pods', '--all-namespaces', '-o', 'json'])) as { items: PodCpu[] }).items,
  );
  const n = burstSize(free, o.limits.cpus);
  const room = Math.floor(free / o.limits.cpus);
  const lanes = (): string => k(['get', 'pods', '-l', 'app.kubernetes.io/component=lanes', '-o', 'jsonpath={.items[*].metadata.uid}']).stdout.trim();
  const lanesBefore = lanes();
  const memoryBefore = hopperMemory(k);
  const runs = memorySandboxRuns();
  const sandboxes = createSandboxes({
    runtime: o.runtime, repo: { list: () => [], remove: () => false }, runs, instanceId: o.instance, network: 'unused', cluster: true,
    clock: { now: () => new Date() }, logger: { info() {}, warn: (line) => console.log(line) },
  });

  const queued = new Set<string>(), seen = new Set<string>(), machine: string[] = [];
  let watching = true;
  // A box that is a machine would be a lane pod, or carry a client's link: the lanes' labels, or HOPPER_CLIENT_*.
  const watch = (async () => {
    while (watching) {
      const r = k(['get', 'pods', '-l', `${NEED_LABEL}=${o.instance}`, '-o', 'json']);
      if (r.status === 0) {
        const pods = (JSON.parse(r.stdout) as { items: (Scheduled & { metadata: { name: string; labels?: Record<string, string> }; spec: { containers: { env?: { name: string }[] }[] } })[] }).items;
        for (const name of unscheduled(pods)) queued.add(name);
        for (const p of pods) {
          if (seen.has(p.metadata.name)) continue;
          seen.add(p.metadata.name);
          if (p.metadata.labels?.['app.kubernetes.io/component'] !== undefined) machine.push(`${p.metadata.name}: the label app.kubernetes.io/component`);
          for (const e of p.spec.containers.flatMap((c) => c.env ?? [])) if (/^HOPPER_(CLIENT|LINK|URL|LANE)/.test(e.name)) machine.push(`${p.metadata.name}: the variable ${e.name}`);
        }
      }
      await sleep(1_000);
    }
  })();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => sandboxes.needStep(USER, {
    name: `hopper-need-kind-burst-${i}-${randomBytes(3).toString('hex')}`, template: { image: o.image },
    env: { ...needEnv({ command: `echo burst-${i}-end > out && sleep 15`, outputs: ['out'], credentials: [] }), HOME }, timeoutMs: 900_000, dir: o.dir,
  }, { log() {}, signal: new AbortController().signal }, { jobId: 'kind-check', step: `burst-${i}`, template: 'kind' })));
  watching = false;
  await watch;
  await sandboxes.stop();

  const wrong = results.flatMap((r, i) => (r.exit !== 0 || r.problem ? [`step ${i}: exit ${r.exit}${r.problem ? `, ${r.problem}` : ''}`]
    : r.outputs?.toString('latin1').includes(`burst-${i}-end`) ? [] : [`step ${i}: its output did not come back`]));
  if (wrong.length > 0) return `many at once: ${wrong.length} of ${n} steps went wrong: ${wrong.slice(0, 5).join('; ')}`;
  if (seen.size < n) return `many at once: ${seen.size} pods were seen of ${n} steps`;
  if (n > room && queued.size === 0) return `many at once: ${n} boxes with room for ${room}, and none waited for the scheduler`;
  if (machine.length > 0) return `many at once: a box is a machine: ${machine.join('; ')}`;
  if (lanes() !== lanesBefore) return 'many at once: the lane pods changed while the boxes ran';
  const left = await gone(k, o.instance);
  if (left.length > 0) return `many at once: left after the steps ended: ${left.join(', ')}`;
  const open = runs.open();
  if (open.length > 0) return `many at once: ${open.length} runs are still open in the ledger: ${open.slice(0, 5).map((r) => r.box).join(', ')}`;
  const problems = sandboxes.view(USER).problems;
  if (problems.length > 0) return `many at once: the sandbox module holds ${problems.length} problems`;
  console.log(`many at once: ${n} steps (room for ${room}, ${queued.size} waited for the scheduler) ran, gave back their outputs and left nothing; no open run, no problem; the hopper's memory ${memoryBefore} before, ${hopperMemory(k)} after`);
  return null;
}
