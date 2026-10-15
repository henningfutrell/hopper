// The Kubernetes API the Kubernetes runtime calls (issue #1286; kubernetes.ts `KubeApi`), through the official client
// (@kubernetes/client-node): its config as the cluster gives it to a pod (the service account), else the kubeconfig;
// its exec over the API's WebSocket. Only the calls the runtime makes, in one namespace.
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { ApiException, CoreV1Api, Exec, KubeConfig, NetworkingV1Api, type V1NetworkPolicy, type V1PersistentVolumeClaim, type V1Pod, type V1Status } from '@kubernetes/client-node';
import { KUBERNETES_CONTAINER } from './flags.ts';
import type { KubeApi } from './kubernetes.ts';

/** Where the cluster puts the namespace of a pod's service account. */
const NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

const codeOf = (e: unknown): number | undefined => (e instanceof ApiException ? e.code : undefined);

/** The API's refusal, in a line: its code and its own message. */
function refusal(what: string, e: unknown): Error {
  if (!(e instanceof ApiException)) return e instanceof Error ? e : new Error(String(e));
  let message = '';
  try {
    const body = (typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { message?: string } | undefined;
    message = body?.message ?? '';
  } catch { /* no message */ }
  return new Error(`Kubernetes refused to ${what}: ${e.code}${message ? ` ${message}` : ''}`);
}

/** The exit code of a command, from the status exec ends with. Throws when it says the command did not run. */
export function exitOf(status: V1Status | undefined): number {
  if (!status) throw new Error('the command ended with no status');
  if (status.status === 'Success') return 0;
  const code = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message;
  if (status.reason === 'NonZeroExitCode' && code !== undefined && /^\d+$/.test(code)) return Number(code);
  throw new Error(`the command did not run: ${status.message ?? status.reason ?? 'no reason given'}`);
}

const ownNamespaceOf = (kc: KubeConfig): string => {
  try {
    return readFileSync(NAMESPACE_FILE, 'utf8').trim();
  } catch {
    return kc.getContextObject(kc.getCurrentContext())?.namespace ?? 'default';
  }
};

/** The API in `namespace` (unset: the hopper's own), and the hopper's own namespace. */
export function createKubeApi(namespace?: string): { api: KubeApi; ownNamespace: string } {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const ownNamespace = ownNamespaceOf(kc);
  const ns = namespace ?? ownNamespace;
  const core = kc.makeApiClient(CoreV1Api), net = kc.makeApiClient(NetworkingV1Api);
  const tolerate = async (what: string, call: () => Promise<unknown>, codes: number[]): Promise<number | undefined> => {
    try {
      await call();
      return undefined;
    } catch (e) {
      const code = codeOf(e);
      if (code !== undefined && codes.includes(code)) return code;
      throw refusal(what, e);
    }
  };
  const api: KubeApi = {
    namespace: ns,
    async readPod(name) {
      try {
        return await core.readNamespacedPod({ name, namespace: ns });
      } catch (e) {
        if (codeOf(e) === 404) return undefined;
        throw refusal(`read the pod ${name}`, e);
      }
    },
    async createPod(body) {
      await tolerate(`create the pod ${String((body.metadata as { name?: string }).name)}`, () => core.createNamespacedPod({ namespace: ns, body: body as V1Pod }), []);
    },
    async deletePod(name, graceS) {
      await tolerate(`remove the pod ${name}`, () => core.deleteNamespacedPod({ name, namespace: ns, gracePeriodSeconds: graceS }), [404]);
    },
    async listPods(labelSelector) {
      try {
        return (await core.listNamespacedPod({ namespace: ns, labelSelector })).items;
      } catch (e) {
        throw refusal('list pods', e);
      }
    },
    async podLog(name) {
      try {
        return await core.readNamespacedPodLog({ name, namespace: ns, container: KUBERNETES_CONTAINER });
      } catch (e) {
        throw refusal(`read what the box ${name} wrote`, e);
      }
    },
    async createClaim(body) {
      const name = String((body.metadata as { name?: string }).name);
      return (await tolerate(`make the claim ${name}`, () => core.createNamespacedPersistentVolumeClaim({ namespace: ns, body: body as V1PersistentVolumeClaim }), [409])) === undefined;
    },
    async readClaim(name) {
      try {
        return await core.readNamespacedPersistentVolumeClaim({ name, namespace: ns });
      } catch (e) {
        if (codeOf(e) === 404) return undefined;
        throw refusal(`read the claim ${name}`, e);
      }
    },
    async listClaims(labelSelector) {
      try {
        return (await core.listNamespacedPersistentVolumeClaim({ namespace: ns, labelSelector })).items;
      } catch (e) {
        throw refusal('list claims', e);
      }
    },
    async deleteClaim(name) {
      await tolerate(`remove the claim ${name}`, () => core.deleteNamespacedPersistentVolumeClaim({ name, namespace: ns }), [404]);
    },
    async applyNetworkPolicy(body) {
      const policy = body as V1NetworkPolicy, name = policy.metadata!.name!;
      const there = await tolerate(`make the network policy ${name}`, () => net.createNamespacedNetworkPolicy({ namespace: ns, body: policy }), [409]);
      if (there) await tolerate(`replace the network policy ${name}`, () => net.replaceNamespacedNetworkPolicy({ name, namespace: ns, body: policy }), []);
    },
    async exec(pod, run) {
      const sink = (to: (chunk: Buffer) => void): Writable => new Writable({ write(chunk: Buffer, _encoding, done) { to(chunk); done(); } });
      let status: V1Status | undefined;
      const ws = await new Exec(kc).exec(ns, pod, KUBERNETES_CONTAINER, run.cmd, sink(run.stdout), sink(run.stderr), run.stdin ?? null, false, (s) => { status = s; });
      return new Promise<number>((resolve, reject) => {
        const stop = (): void => {
          ws.close();
          reject(new Error(`the wait for the command in the box ${pod} was stopped`));
        };
        run.signal?.addEventListener('abort', stop, { once: true });
        ws.on('error', (e) => reject(e));
        ws.on('close', () => {
          run.signal?.removeEventListener('abort', stop);
          try {
            resolve(exitOf(status));
          } catch (e) {
            reject(e);
          }
        });
      });
    },
  };
  return { api, ownNamespace };
}
