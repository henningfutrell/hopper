// An in-memory Kubernetes API at the Kubernetes runtime's seam (src/sandbox/kubernetes.ts `KubeApi`): pods, claims and
// network policies by name in one namespace, a label selector of `key=value` terms, and an exec that answers what the
// test says. A pod starts Pending; the test moves it on with `phase`.
import type { V1Pod } from '@kubernetes/client-node';
import type { KubeApi, KubeExec } from '../../src/sandbox/kubernetes.ts';

export interface FakeKubeApi extends KubeApi {
  pods: Map<string, V1Pod>;
  claims: Map<string, Record<string, unknown>>;
  policies: Map<string, Record<string, unknown>>;
  /** Every call, in order: `createPod name`, `applyNetworkPolicy name`, … */
  calls: string[];
  /** The commands exec ran, with their pod. */
  execs: { pod: string; cmd: string[]; stdin?: string }[];
  /** Sets a pod's phase, and its container's state to match (`exitCode` for an ended one, `waiting` for a pending one). */
  phase(name: string, phase: string, o?: { exitCode?: number; waiting?: string }): void;
  /** How exec answers: its exit code and what it writes. Default: 0, nothing. */
  onExec?: (pod: string, cmd: string[]) => { exit: number; stdout?: string; stderr?: string } | Error;
  logs: Map<string, string>;
  /** Set: every call throws it. */
  refuse?: Error;
}

const matches = (selector: string, labels: Record<string, string>): boolean =>
  selector.split(',').filter((t) => t !== '').every((t) => {
    const [k, v] = t.split('=');
    return labels[k!] === v;
  });

export function createFakeKubeApi(namespace = 'hopper'): FakeKubeApi {
  const api: FakeKubeApi = {
    namespace, pods: new Map(), claims: new Map(), policies: new Map(), calls: [], execs: [], logs: new Map(),
    phase(name, phase, o = {}) {
      const p = api.pods.get(name);
      if (!p) throw new Error(`no pod ${name}`);
      const state = phase === 'Running' ? { running: {} } : phase === 'Succeeded' || phase === 'Failed' ? { terminated: { exitCode: o.exitCode ?? 0 } } : { waiting: { reason: o.waiting ?? 'ContainerCreating' } };
      p.status = { phase, containerStatuses: [{ name: 'box', image: '', imageID: '', ready: phase === 'Running', restartCount: 0, state }] };
    },
    async readPod(name) {
      api.calls.push(`readPod ${name}`);
      if (api.refuse) throw api.refuse;
      return api.pods.get(name);
    },
    async createPod(body) {
      const pod = body as V1Pod;
      api.calls.push(`createPod ${pod.metadata!.name}`);
      if (api.refuse) throw api.refuse;
      if (api.pods.has(pod.metadata!.name!)) throw new Error(`pods "${pod.metadata!.name}" already exists`);
      api.pods.set(pod.metadata!.name!, { ...pod, status: { phase: 'Pending' } });
    },
    async deletePod(name) {
      api.calls.push(`deletePod ${name}`);
      if (api.refuse) throw api.refuse;
      api.pods.delete(name);
    },
    async listPods(selector) {
      api.calls.push(`listPods ${selector}`);
      if (api.refuse) throw api.refuse;
      return [...api.pods.values()].filter((p) => matches(selector, p.metadata?.labels ?? {}));
    },
    async podLog(name) {
      if (api.refuse) throw api.refuse;
      return api.logs.get(name) ?? '';
    },
    async createClaim(body) {
      const name = (body.metadata as { name: string }).name;
      api.calls.push(`createClaim ${name}`);
      if (api.refuse) throw api.refuse;
      if (api.claims.has(name)) return false;
      api.claims.set(name, body);
      return true;
    },
    async readClaim(name) {
      api.calls.push(`readClaim ${name}`);
      if (api.refuse) throw api.refuse;
      return api.claims.get(name) as { metadata?: { labels?: Record<string, string> } } | undefined;
    },
    async listClaims(selector) {
      api.calls.push(`listClaims ${selector}`);
      if (api.refuse) throw api.refuse;
      return [...api.claims.values()].filter((c) => matches(selector, (c.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {})) as { metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> } }[];
    },
    async deleteClaim(name) {
      api.calls.push(`deleteClaim ${name}`);
      if (api.refuse) throw api.refuse;
      api.claims.delete(name);
    },
    async applyNetworkPolicy(body) {
      const name = (body.metadata as { name: string }).name;
      api.calls.push(`applyNetworkPolicy ${name}`);
      if (api.refuse) throw api.refuse;
      api.policies.set(name, body);
    },
    async exec(pod, run: KubeExec) {
      let stdin: string | undefined;
      if (run.stdin) {
        const chunks: Buffer[] = [];
        for await (const c of run.stdin) chunks.push(Buffer.from(c as Buffer));
        stdin = Buffer.concat(chunks).toString('utf8');
      }
      api.execs.push({ pod, cmd: run.cmd, ...(stdin !== undefined ? { stdin } : {}) });
      if (api.refuse) throw api.refuse;
      const answer = api.onExec?.(pod, run.cmd) ?? { exit: 0 };
      if (answer instanceof Error) throw answer;
      if (answer.stdout) run.stdout(Buffer.from(answer.stdout));
      if (answer.stderr) run.stderr(Buffer.from(answer.stderr));
      return answer.exit;
    },
  };
  return api;
}
