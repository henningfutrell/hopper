// A bastion (issue #2146, design.md "Bastions"): the one sandbox that outlives a step. A job names its targets — a
// service, a pod or a deployment and one port, in a namespace of a cluster — and the hopper starts one need box of a
// template approved for an **observe** on each target's namespace or cluster. The box holds `kubectl port-forward` to
// each target on 127.0.0.1 inside it, a local port each that kubectl picks, and starts a forward again when it ends (a pod that restarted).
// Its kube tokens are files the hopper renews while it runs (the kubeconfig's `tokenFile`, which kubectl reads again
// within a minute); they never go to the job. Only the box reaches the forwards: the hopper's relay (part 2) joins a
// job's connection to one through a command it starts in the box for each connection (relayCommand). Part 3: a bastion
// forwards only to targets its template names as bastion targets, each approved by a person with the template. Pure.
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import { credentialName } from './need-box.ts';

/** How long a bastion lives with no use: its TTL, renewed by each relay connection, and kept while one is open. */
export const BASTION_TTL_MS = 60 * 60_000;
/** The most a bastion lives, in use or not: its need box's time limit. */
export const BASTION_MAX_MS = 12 * 60 * 60_000;
/** How often the hopper mints a bastion's tokens again: well within a token's 10 minutes (an EKS token's 14). */
export const BASTION_RENEW_MS = 5 * 60_000;
/** The most targets one bastion forwards to. */
export const BASTION_TARGETS_MAX = 8;

/** What a forward may name, as `kubectl port-forward` takes it. */
export const TARGET_KINDS = ['svc', 'pod', 'deploy'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** One target: `<cluster>/<namespace>/<kind>/<name>:<port>`. */
export interface BastionTarget { cluster: string; namespace: string; kind: TargetKind; name: string; port: number }
/** A target in its bastion: the kubeconfig context of its observe. Its port on 127.0.0.1 in the box is kubectl's pick. */
export interface PlacedTarget extends BastionTarget { context: string }

/** A Kubernetes name: a DNS label or subdomain. A cluster's name as the hopper names it. */
const KUBE_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const CLUSTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const TARGET = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/([^/:\s]+):(\d{1,5})$/;
const SAY = 'a target is <cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>, for example utility/monitoring/svc/prometheus-server:9090';

export const targetText = (t: BastionTarget): string => `${t.cluster}/${t.namespace}/${t.kind}/${t.name}:${t.port}`;

/** The targets a job names, space-separated; or why they cannot be read. The same target twice is one. */
export function parseTargets(text: string | undefined): BastionTarget[] | string {
  const words = [...new Set((text ?? '').split(/\s+/).filter((w) => w !== ''))];
  if (words.length === 0) return `name the targets with --targets: ${SAY}`;
  if (words.length > BASTION_TARGETS_MAX) return `a bastion forwards to at most ${BASTION_TARGETS_MAX} targets, not ${words.length}`;
  const targets: BastionTarget[] = [];
  for (const w of words) {
    const m = TARGET.exec(w);
    if (!m) return `${w}: ${SAY}`;
    const [, cluster, namespace, kind, name, port] = m as unknown as [string, string, string, string, string, string];
    if (!CLUSTER.test(cluster)) return `${w}: ${cluster} is no cluster name: letters, digits, _ and -`;
    if (!KUBE_NAME.test(namespace) || namespace.includes('.')) return `${w}: ${namespace} is no namespace name`;
    if (!(TARGET_KINDS as readonly string[]).includes(kind)) return `${w}: forward to ${TARGET_KINDS.join(', ')} only, not ${kind}`;
    if (!KUBE_NAME.test(name)) return `${w}: ${name} is no Kubernetes name`;
    const n = Number(port);
    if (n < 1 || n > 65535) return `${w}: the port is 1 to 65535`;
    targets.push({ cluster, namespace, kind: kind as TargetKind, name, port: n });
  }
  return targets;
}

/** The observe of `profiles` that reaches the target: one on its namespace first, else one on its cluster. */
export function observeOf(t: BastionTarget, profiles: readonly OperationProfile[]): OperationProfile | undefined {
  const observes = profiles.filter((p) => p.operation === 'observe');
  return observes.find((p) => p.asset.kind === 'namespace' && p.asset.name === `${t.cluster}/${t.namespace}`)
    ?? observes.find((p) => p.asset.kind === 'cluster' && p.asset.name === t.cluster);
}

/** Each target with its context, and the observes they need, each once; or why a target is out of reach. */
export function placeTargets(targets: readonly BastionTarget[], profiles: readonly OperationProfile[]): { placed: PlacedTarget[]; observes: OperationProfile[] } | string {
  const out = targets.filter((t) => !observeOf(t, profiles));
  if (out.length) {
    return `the template has no observe on ${out.map((t) => `${t.cluster}/${t.namespace}`).join(', ')}: ask for a template with ${[...new Set(out.map((t) => `observe/namespace/${t.cluster}/${t.namespace}`))].join(' ')}`;
  }
  const observes: OperationProfile[] = [];
  const placed = targets.map((t) => {
    const p = observeOf(t, profiles)!;
    if (!observes.includes(p)) observes.push(p);
    return { ...t, context: credentialName(p) };
  });
  return { placed, observes };
}

/** The most bastion targets one template names. */
export const TEMPLATE_TARGETS_MAX = 32;

/**
 * A template's bastion targets as a save takes them (part 3): each a target an observe of its `profiles` reaches, sorted,
 * each once; or why one is not.
 */
export function templateTargets(list: readonly string[], profiles: readonly OperationProfile[]): string[] | string {
  const words = [...new Set(list.map((w) => w.trim()).filter((w) => w !== ''))];
  if (words.length > TEMPLATE_TARGETS_MAX) return `a template names at most ${TEMPLATE_TARGETS_MAX} bastion targets, not ${words.length}`;
  const targets: BastionTarget[] = [];
  for (const w of words) {
    const t = parseTargets(w);
    if (typeof t === 'string') return `bastion target ${t}`;
    targets.push(...t);
  }
  const placed = placeTargets(targets, profiles);
  if (typeof placed === 'string') return `bastion targets: ${placed}`;
  return targets.map(targetText).sort();
}

/** What a template says of its bastion targets: the ones it names, and the ones that wait for a person (its view). */
export interface TargetsOf { name: string; bastionTargets?: readonly string[]; pending: { bastionTargets?: readonly string[] } }

/** Whether a person approved `target` with the template: it names it, and it does not wait. */
export const approvedTarget = (t: TargetsOf | undefined, target: string): boolean =>
  t !== undefined && (t.bastionTargets ?? []).includes(target) && !(t.pending.bastionTargets ?? []).includes(target);

/**
 * Why a bastion of the template may not forward to `targets` (part 3): a target it does not name (`unnamed`), or one a
 * person has not approved with it yet (`waiting`); undefined: each is approved.
 */
export function targetsOutside(t: TargetsOf, targets: readonly BastionTarget[]): { why: 'unnamed' | 'waiting'; targets: string[]; no: string } | undefined {
  const asked = targets.map(targetText);
  const unnamed = asked.filter((x) => !(t.bastionTargets ?? []).includes(x));
  if (unnamed.length) return { why: 'unnamed', targets: unnamed, no: `template ${t.name} names no bastion target ${unnamed.join(', ')}` };
  const waiting = asked.filter((x) => !approvedTarget(t, x));
  if (!waiting.length) return undefined;
  const one = waiting.length === 1;
  return { why: 'waiting', targets: waiting, no: `the bastion target${one ? '' : 's'} ${waiting.join(', ')} of template ${t.name} wait${one ? 's' : ''} for a person to approve ${one ? 'it' : 'them'} on Access requests` };
}

/** The vault secret file of a context's token in the box: `$HOME/.hopper-need/secrets/<name>`. */
export const tokenName = (context: string): string => `kube-${context}`;

/** One observe's minted token and where it is used. */
export interface BastionCredential { profile: OperationProfile; minted: Extract<Minted, { kind: 'kube' }>; reach: Extract<MintReach, { kind: 'kube' }> }

/** Each context's token, as the box takes its vault secrets: at its start, and again at each renewal. */
export const bastionTokens = (credentials: readonly BastionCredential[]): Record<string, string> =>
  Object.fromEntries(credentials.map((c) => [tokenName(credentialName(c.profile)), c.minted.token]));

/**
 * The kubeconfig: one context for each observe, its user's token a file (`tokenFile`, relative to the kubeconfig in
 * `$HOME/.kube`), so a renewed token is read with no new kubeconfig.
 */
export function bastionKubeconfig(credentials: readonly BastionCredential[]): string {
  const named = credentials.map((c) => ({ name: credentialName(c.profile), c }));
  return JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': named[0]?.name ?? '',
    clusters: named.map(({ name, c }) => ({ name, cluster: { server: c.reach.server, ...(c.reach.certificateAuthorityData ? { 'certificate-authority-data': c.reach.certificateAuthorityData } : {}) } })),
    users: named.map(({ name }) => ({ name, user: { tokenFile: `../.hopper-need/secrets/${tokenName(name)}` } })),
    contexts: named.map(({ name }) => ({ name, context: { cluster: name, user: name } })),
  });
}

/** The bastion's need box environment: its command, no outputs, and the kubeconfig the box's script writes. */
export const bastionEnv = (placed: readonly PlacedTarget[], credentials: readonly BastionCredential[]): Record<string, string> =>
  ({ HOPPER_STEP_COMMAND: bastionCommand(placed), HOPPER_STEP_OUTPUTS: '', HOPPER_STEP_KUBECONFIG: bastionKubeconfig(credentials) });

/**
 * The bastion's command: a forward to each target on 127.0.0.1, on a free port kubectl picks, each in a loop that starts it again 2 s after it ends,
 * its lines marked with its target; then it waits. It ends only when the hopper stops its box. Issue #2566: a box on a
 * client machine shares the machine's network, so a fixed port (20000 and on, before) may be another box's or process's:
 * the relay reaches the port kubectl says it forwards from (forwardWatch).
 */
export function bastionCommand(placed: readonly PlacedTarget[]): string {
  const lines = placed.map((t) => `forward '${t.context}' '${t.namespace}' '${t.kind}/${t.name}' ${t.port} '${targetText(t)}' &`);
  return [
    'forward() {',
    '  while :; do',
    '    kubectl --context "$1" --namespace "$2" port-forward --address 127.0.0.1 "$3" ":$4" 2>&1 | while IFS= read -r line; do echo "[$5] $line"; done',
    '    echo "[$5] the forward ended: it starts again in 2 s"',
    '    sleep 2',
    '  done',
    '}',
    ...lines,
    `echo "hopper-bastion: forwarding ${placed.length} target${placed.length === 1 ? '' : 's'}"`,
    'wait',
  ].join('\n');
}

/**
 * What the bastion's output says of one forward (issue #2413): it listens, or not, with the last thing kubectl said;
 * `local` (issue #2566): the port on 127.0.0.1 in the box it listens on, as kubectl said.
 */
export interface ForwardState { listening: boolean; local?: number; said?: string }

/** The last thing kubectl said of a forward that was no state (issue #2474), and how many such lines it said. */
export interface ForwardProblem { n: number; said: string }

const FORWARD_LINE = /^\[([^\]]+)\] (.*)$/;
const ENDED = 'the forward ended:';
const FORWARDING = /^Forwarding from 127\.0\.0\.1:(\d{1,5}) /;

/** A forward that listens, with its port when kubectl's line names it. */
const listening = (words: string): ForwardState => {
  const port = Number(FORWARDING.exec(words)?.[1]);
  return port > 0 && port < 65536 ? { listening: true, local: port } : { listening: true };
};

/**
 * Reads the bastion's output as it comes (bastionCommand marks each forward's lines with its target): a forward listens
 * once kubectl says "Forwarding from", and stops when its loop says it ended, which keeps the last thing kubectl said.
 * A connection it handles, or an error of one connection, does not end it. A line cut over two chunks is read whole;
 * a "Forwarding from" counts before its new line.
 */
export function forwardWatch(): { add(chunk: string): void; of(target: string): ForwardState | undefined; problem(target: string): ForwardProblem | undefined } {
  const states = new Map<string, ForwardState>();
  const said = new Map<string, string>();
  // Issue #2474: the last thing kubectl said of a forward that was no state, counted, so a connection that got no answer
  // finds what kubectl said after it opened (an error of that one connection, which leaves the forward listening).
  const problems = new Map<string, ForwardProblem>();
  let rest = '';
  const line = (text: string): void => {
    const m = FORWARD_LINE.exec(text.replace(/\r$/, ''));
    if (!m) return;
    const [, target, words] = m as unknown as [string, string, string];
    if (words.startsWith('Forwarding from ')) { states.set(target, listening(words)); said.delete(target); return; }
    if (words.startsWith('Handling connection for ')) return;
    if (words.startsWith(ENDED)) { states.set(target, { listening: false, said: said.get(target) ?? words }); said.delete(target); return; }
    said.set(target, words);
    problems.set(target, { n: (problems.get(target)?.n ?? 0) + 1, said: words });
  };
  return {
    add(chunk) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop()!;
      for (const l of lines) line(l);
      // Issue #2484: the need box holds back a last new line (it may start its outputs' mark), so kubectl's "Forwarding
      // from", often its last line for a long time, comes with no new line: it counts before its new line comes.
      const m = FORWARD_LINE.exec(rest);
      if (m?.[2]?.startsWith('Forwarding from ')) states.set(m[1]!, listening(m[2]));
    },
    of: (target) => states.get(target),
    problem: (target) => problems.get(target),
  };
}

/**
 * The command the relay starts in the box for one connection (part 2): its stdin to 127.0.0.1:`local`, what comes back to
 * its stdout. It takes the first the box's image has of socat, bash (its /dev/tcp) and nc. It ends when the target ends
 * the connection; when its stdin ends first, it waits at most 5 s for the rest of the answer. Exit 127: the image has
 * none of them.
 */
export const relayCommand = (local: number): string[] => ['sh', '-c', RELAY_CONNECT, 'hopper-relay', String(local)];

export const RELAY_CONNECT = `p=$1
if command -v socat >/dev/null 2>&1; then exec socat -t 5 - "TCP:127.0.0.1:$p"; fi
if command -v bash >/dev/null 2>&1; then
  exec bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1" || exit 1
cat <&3 & r=$!
cat <&0 >&3 & w=$!
wait -n
if kill -0 $r 2>/dev/null; then (sleep 5; kill $r) >/dev/null 2>&1 & s=$!; wait $r; kill $s 2>/dev/null; fi
kill $w 2>/dev/null
exit 0' hopper-relay "$p"
fi
if command -v nc >/dev/null 2>&1; then exec nc 127.0.0.1 "$p"; fi
echo "hopper-relay: the box's image has no socat, bash or nc to reach 127.0.0.1:$p" >&2
exit 127`;
