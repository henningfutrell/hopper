// The Kubernetes API, as job pods use it (issue #1283, design.md "Job pods on Kubernetes"): pods in one namespace, over
// node:https, with the service account's token. Five calls — create, read, delete and list pods, and a list as the
// check that the API answers —, so written here, as the Podman adapter is (src/sandbox/podman.ts): the official client
// (@kubernetes/client-node) brings a large dependency tree for them. Every path names the namespace: the hopper's role
// (deploy/kubernetes/rbac.yaml) lets it manage pods there and nothing else.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { KubernetesPods, PodManifest, PodState } from '../domain/pods.ts';

/** Where a pod's service account is mounted: its token (rotated by the kubelet), the cluster's CA and its namespace. */
export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubernetesApiOptions {
  /** The API server: `https://<host>:<port>` (in a pod, from KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT). */
  server: string;
  /** The bearer token, read at each call: the kubelet rotates a projected token. */
  token: () => string;
  /** The cluster's CA, PEM: the only one the API server's certificate is checked against. */
  ca?: string;
  namespace: string;
  /** Each call's limit. Default 15000 ms. */
  timeoutMs?: number;
}

/** What a pod's own service account gives: the API server, its token, the CA and the namespace. Throws when it is not in a pod. */
export function inClusterOptions(env: (name: string) => string | undefined, dir = SERVICE_ACCOUNT_DIR, namespace?: string): KubernetesApiOptions {
  const host = env('KUBERNETES_SERVICE_HOST');
  const port = env('KUBERNETES_SERVICE_PORT') ?? '443';
  if (!host) throw new Error('not in a Kubernetes pod: KUBERNETES_SERVICE_HOST is not set');
  const read = (file: string): string => {
    try { return readFileSync(`${dir}/${file}`, 'utf8').trim(); } catch (e) {
      throw new Error(`no service account ${file} at ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
    }
  };
  return {
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: () => read('token'),
    ca: read('ca.crt'),
    namespace: namespace ?? read('namespace'),
  };
}

/** A namespace or pod name as the API takes it: a DNS label. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL_KEY = /^([a-z0-9.-]{1,253}\/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;

const PHASES = new Set(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']);

export class KubernetesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createKubernetesPods(o: KubernetesApiOptions): KubernetesPods {
  if (!DNS_LABEL.test(o.namespace)) throw new Error(`bad namespace: ${JSON.stringify(o.namespace)}`);
  const base = new URL(o.server);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error(`the API server must be an https URL: ${o.server}`);
  const pods = `/api/v1/namespaces/${o.namespace}/pods`;

  function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send({
        protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || (base.protocol === 'https:' ? 443 : 80), method, path,
        headers: { authorization: `Bearer ${o.token()}`, accept: 'application/json', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) },
        ...(o.ca ? { ca: o.ca } : {}), timeout: o.timeoutMs ?? 15000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => {
          let json: unknown;
          try { json = data ? JSON.parse(data) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`no answer from the Kubernetes API within ${o.timeoutMs ?? 15000} ms`)));
      req.on('error', reject);
      req.end(text);
    });
  }

  /** The API's own reason for a refusal: its Status message. */
  const refused = (what: string, r: { status: number; json: unknown }): KubernetesError => {
    const message = (r.json as { message?: unknown } | undefined)?.message;
    return new KubernetesError(r.status, `${what}: ${r.status}${typeof message === 'string' ? ` ${message}` : ''}`);
  };

  const named = (name: string): string => {
    if (!DNS_LABEL.test(name)) throw new Error(`bad pod name: ${JSON.stringify(name)}`);
    return `${pods}/${name}`;
  };

  return {
    namespace: o.namespace,
    async problem() {
      try {
        const r = await call('GET', `${pods}?limit=1`);
        return r.status === 200 ? undefined : refused(`the Kubernetes API refused a pod list in namespace ${o.namespace}`, r).message;
      } catch (e) {
        return `the Kubernetes API at ${o.server} is not reached: ${(e as Error).message}`;
      }
    },
    async create(pod: PodManifest) {
      const r = await call('POST', pods, pod);
      if (r.status !== 201 && r.status !== 200 && r.status !== 202) throw refused('the Kubernetes API did not create the pod', r);
    },
    async state(name): Promise<PodState | undefined> {
      const r = await call('GET', named(name));
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw refused(`the Kubernetes API did not read pod ${name}`, r);
      const status = (r.json as { status?: { phase?: unknown; reason?: unknown; message?: unknown } } | undefined)?.status;
      const phase = typeof status?.phase === 'string' && PHASES.has(status.phase) ? status.phase as PodState['phase'] : 'Unknown';
      const reason = [status?.reason, status?.message].filter((x): x is string => typeof x === 'string' && x !== '').join(': ');
      return { phase, ...(reason ? { reason } : {}) };
    },
    async remove(name) {
      const r = await call('DELETE', named(name), { kind: 'DeleteOptions', apiVersion: 'v1', gracePeriodSeconds: 10, propagationPolicy: 'Background' });
      if (r.status !== 200 && r.status !== 202 && r.status !== 404) throw refused(`the Kubernetes API did not delete pod ${name}`, r);
    },
    async list(labels) {
      const selector = Object.entries(labels).map(([k, v]) => {
        if (!LABEL_KEY.test(k) || !LABEL_VALUE.test(v)) throw new Error(`bad label ${k}=${v}`);
        return `${k}=${v}`;
      }).join(',');
      const r = await call('GET', `${pods}?labelSelector=${encodeURIComponent(selector)}`);
      if (r.status !== 200) throw refused(`the Kubernetes API did not list pods in namespace ${o.namespace}`, r);
      const items = (r.json as { items?: { metadata?: { name?: unknown } }[] } | undefined)?.items ?? [];
      return items.flatMap((p) => (typeof p.metadata?.name === 'string' ? [p.metadata.name] : []));
    },
  };
}
