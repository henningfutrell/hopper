// The Kubernetes container runtime (issue #1286, part of #1281): sandbox boxes as pods in one namespace, through the
// Kubernetes API (kubernetes-api.ts), with no container socket. A box is a pod, its home a PersistentVolumeClaim; the
// sandbox flags are the pod's security context (flags.ts). One NetworkPolicy holds every pod of the hopper's, applied
// before each pod is made: no ingress, and egress only to DNS, the hopper's pods on its port and public addresses — no
// other pod or address of the cluster. Nothing is built here: a box with tools runs the tools image CI published
// (box-image.ts `publishedToolsImage`). Files are copied into a box through the API's exec.
//
// The runtime sees only its own pods (the label POD_LABEL): another pod of the namespace, the hopper's own included, is
// no container of it, and it stops and removes only its own pods and claims (issue #1371). A name Kubernetes does not take (a template name with `_` or `.`, one too long) is made DNS-safe,
// and the hopper's name is kept on the pod, so the runtime answers it as given; a label value Kubernetes does not take
// is selected by its hash, and answered as given too.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { V1Pod } from '@kubernetes/client-node';
import type { ContainerInfo, ContainerRuntime } from '../domain/sandboxes.ts';
import { KUBERNETES_USER, kubernetesPodBody, STOP_S } from './flags.ts';
import { notASandbox } from './owned.ts';

/** The label on every pod and claim the runtime makes: what it lists, inspects and holds under its egress policy. */
export const POD_LABEL = 'io.hopper.sandbox-pod';
/** The NetworkPolicy that holds them. */
export const POLICY = 'hopper-sandbox';
/** The size of a box's home claim. */
export const HOME_SIZE = '5Gi';
const NAME_ANNOTATION = 'io.hopper.name';
const LABELS_ANNOTATION = 'io.hopper.labels';
/** How long a pod may take to start, its image pull included. */
const START_MS = 15 * 60_000;
/** A container that waits for one of these does not start without a change. */
const CANNOT_START = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull', 'CreateContainerConfigError', 'CreateContainerError']);
/** Addresses a box never reaches but the hopper's and DNS: the private, shared, loopback and link-local ranges. */
const PRIVATE_V4 = ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'];
const PRIVATE_V6 = ['::1/128', 'fc00::/7', 'fe80::/10'];

/** A command run in a pod's box container through exec: its argv, where its output goes, what it reads. */
export interface KubeExec {
  cmd: string[];
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  stdin?: Readable;
  signal?: AbortSignal;
}

/** The calls the runtime makes of the Kubernetes API, in its namespace (kubernetes-api.ts; a double in the tests). */
export interface KubeApi {
  readonly namespace: string;
  /** Undefined: no such pod. */
  readPod(name: string): Promise<V1Pod | undefined>;
  createPod(body: Record<string, unknown>): Promise<void>;
  /** One already gone is no error. */
  deletePod(name: string, graceS: number): Promise<void>;
  listPods(selector: string): Promise<V1Pod[]>;
  podLog(name: string): Promise<string>;
  /** False: one of that name is there already, kept as it is. */
  createClaim(body: Record<string, unknown>): Promise<boolean>;
  /** Undefined: no such claim. */
  readClaim(name: string): Promise<{ metadata?: { labels?: Record<string, string> } } | undefined>;
  /** The claims that carry every label of the selector. */
  listClaims(selector: string): Promise<{ metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> } }[]>;
  /** One already gone is no error. */
  deleteClaim(name: string): Promise<void>;
  /** Made, or replaced when one of its name is there. */
  applyNetworkPolicy(body: Record<string, unknown>): Promise<void>;
  /** Runs the command in the pod's box container; answers its exit code. */
  exec(pod: string, run: KubeExec): Promise<number>;
}

/** The hopper's pods, as the egress policy lets a box reach them: their namespace, their labels and the hopper's port. */
export interface HopperPods { namespace: string; labels: Record<string, string>; port: number }

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/** The name Kubernetes takes for `name`: itself when it is a DNS label, else a DNS-safe stem and a hash of it. */
export function kubeName(name: string): string {
  if (DNS_LABEL.test(name)) return name;
  const stem = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 50).replace(/-+$/, '');
  return `${stem || 'box'}-${hash(name).slice(0, 10)}`;
}

/** The label value Kubernetes takes for `value`: itself when it can, else its hash. */
const labelValue = (value: string): string => (value.length <= 63 && LABEL_VALUE.test(value) ? value : `h${hash(value).slice(0, 40)}`);
const selectable = (labels: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, labelValue(v)]));
const selector = (labels: Record<string, string> = {}): string => Object.entries({ [POD_LABEL]: 'true', ...selectable(labels) }).map(([k, v]) => `${k}=${v}`).join(',');

/** The egress policy (issue #1286): no ingress; egress to DNS, the hopper's pods on its port, and public addresses only. */
export function egressPolicy(h: HopperPods): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: POLICY, labels: { [POD_LABEL]: 'policy' } },
    spec: {
      podSelector: { matchLabels: { [POD_LABEL]: 'true' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        { to: [{ namespaceSelector: {} }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': h.namespace } }, podSelector: { matchLabels: h.labels } }], ports: [{ protocol: 'TCP', port: h.port }] },
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_V4 } }, { ipBlock: { cidr: '::/0', except: PRIVATE_V6 } }] },
      ],
    },
  };
}

/** The runtime's word for the pod's state, as Podman's: `created`, `running`, `exited`, `removing`. */
function stateOf(p: V1Pod): string {
  if (p.metadata?.deletionTimestamp) return 'removing';
  switch (p.status?.phase) {
    case 'Pending': return 'created';
    case 'Running': return 'running';
    case 'Succeeded': case 'Failed': return 'exited';
    default: return 'unknown';
  }
}

function infoOf(p: V1Pod): ContainerInfo {
  const id = p.metadata?.name ?? '';
  const a = p.metadata?.annotations ?? {};
  let labels = p.metadata?.labels ?? {};
  try {
    if (a[LABELS_ANNOTATION]) labels = JSON.parse(a[LABELS_ANNOTATION]) as Record<string, string>;
  } catch { /* the labels as Kubernetes holds them */ }
  return { id, name: a[NAME_ANNOTATION] ?? id, image: p.spec?.containers[0]?.image ?? '', labels, state: stateOf(p) };
}

/** Why a pending pod has not started: what its container waits for, or why it is not scheduled. */
function pendingWhy(p: V1Pod): string {
  const waiting = p.status?.containerStatuses?.[0]?.state?.waiting;
  if (waiting?.reason) return `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`;
  const unscheduled = p.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  return unscheduled?.message ?? 'it is pending';
}

export function createKubernetesRuntime(o: { api: KubeApi; hopper: HopperPods; pollMs?: number; startMs?: number }): ContainerRuntime {
  const { api } = o;
  const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, o.pollMs ?? 1_000));
  /** The pod, by its id or the hopper's name for it; undefined: none of the runtime's. */
  const read = async (id: string): Promise<V1Pod | undefined> => {
    const p = await api.readPod(kubeName(id));
    return p?.metadata?.labels?.[POD_LABEL] === 'true' ? p : undefined;
  };
  /** Deletes the runtime's own pod (issue #1371): one that carries no POD_LABEL, the hopper's own included, is refused. */
  const takePod = async (id: string): Promise<void> => {
    const p = await api.readPod(kubeName(id));
    if (!p) return;
    if (p.metadata?.labels?.[POD_LABEL] !== 'true') throw notASandbox(`pod ${kubeName(id)}`);
    await api.deletePod(kubeName(id), STOP_S);
  };
  const run = (id: string, cmd: string[], out: (chunk: Buffer, stream: 1 | 2) => void, more: { stdin?: Readable; signal?: AbortSignal } = {}): Promise<number> =>
    api.exec(id, { cmd, stdout: (c) => out(c, 1), stderr: (c) => out(c, 2), ...more });

  return {
    kind: 'kubernetes',

    async problem() {
      try {
        await api.listPods(selector());
        return undefined;
      } catch (e) {
        return `cannot reach the Kubernetes API in the namespace ${api.namespace}: ${e instanceof Error ? e.message : String(e)}`;
      }
    },

    // The image is pulled by the node that runs the pod: the hopper cannot read it. Every box runs as the box image's
    // agent user, by number, whatever user the image names, and the kubelet refuses root.
    pull: async () => ({ user: KUBERNETES_USER }),

    async createVolume(name, labels) {
      return api.createClaim({
        apiVersion: 'v1', kind: 'PersistentVolumeClaim',
        metadata: { name: kubeName(name), labels: { ...selectable(labels), [POD_LABEL]: 'claim' }, annotations: { [NAME_ANNOTATION]: name } },
        spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: HOME_SIZE } } },
      });
    },

    // Only its own claim (issue #1371): a claim of the hopper's Postgres, or anyone's, carries no POD_LABEL.
    async removeVolume(name) {
      const claim = await api.readClaim(kubeName(name));
      if (!claim) return;
      if (claim.metadata?.labels?.[POD_LABEL] !== 'claim') throw notASandbox(`claim ${kubeName(name)}`);
      await api.deleteClaim(kubeName(name));
    },

    // Only its own claims (issue #1371), by the hopper's name for each: removeVolume takes it.
    async listVolumes(labels) {
      const claims = await api.listClaims(Object.entries({ ...selectable(labels), [POD_LABEL]: 'claim' }).map(([k, v]) => `${k}=${v}`).join(','));
      return claims.map((c) => c.metadata?.annotations?.[NAME_ANNOTATION] ?? c.metadata?.name ?? '').filter((n) => n !== '');
    },

    async create(spec) {
      const name = kubeName(spec.name);
      const annotations = { [NAME_ANNOTATION]: spec.name, [LABELS_ANNOTATION]: JSON.stringify(spec.labels) };
      const body = kubernetesPodBody(spec, { name, claim: kubeName(spec.volume), labels: { ...selectable(spec.labels), [POD_LABEL]: 'true' }, annotations });
      // Before the pod: no box of the hopper's runs a moment without its egress policy.
      await api.applyNetworkPolicy(egressPolicy(o.hopper));
      await api.createPod(body);
      return name;
    },

    // A pod starts as it is made: this waits until it runs (or ran), so a command can run in it.
    async start(id) {
      const end = Date.now() + (o.startMs ?? START_MS);
      for (;;) {
        const p = await read(id);
        if (!p) throw new Error(`the box ${id} is gone`);
        if (p.status?.phase !== undefined && p.status.phase !== 'Pending') return;
        const waiting = p.status?.containerStatuses?.[0]?.state?.waiting?.reason;
        if (waiting && CANNOT_START.has(waiting)) throw new Error(`Kubernetes cannot start the box ${id}: ${pendingWhy(p)}`);
        if (Date.now() >= end) throw new Error(`the box ${id} did not start in ${Math.round((o.startMs ?? START_MS) / 1000)} s: ${pendingWhy(p)}`);
        await sleep();
      }
    },

    async wait(id, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const p = await read(id);
        if (!p) throw new Error(`the box ${id} is gone`);
        if (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') return p.status.containerStatuses?.[0]?.state?.terminated?.exitCode ?? -1;
        if (Date.now() >= end) throw new Error(`the box ${id} did not end in ${Math.round(timeoutMs / 1000)} s`);
        await sleep();
      }
    },

    logs: (id) => api.podLog(id),

    async inspect(id) {
      const p = await read(id);
      return p && infoOf(p);
    },

    stop: (id) => takePod(id),
    remove: (id) => takePod(id),

    list: async (labels) => (await api.listPods(selector(labels))).map(infoOf),

    // As the box's user, so the files are its own; the home's directories stay as they are (the claim's root is not its).
    async copyIn(id, dir, tar) {
      const errors: Buffer[] = [];
      const exit = await run(id, ['tar', '-x', '-m', '--no-overwrite-dir', '-f', '-', '-C', dir], (chunk, stream) => { if (stream === 2) errors.push(chunk); }, { stdin: createReadStream(tar) });
      if (exit !== 0) throw new Error(`could not copy files into the box ${id}: tar ended with ${exit}: ${Buffer.concat(errors).toString('utf8').trim()}`);
    },
  };
}
