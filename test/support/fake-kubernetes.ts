// A fake Kubernetes API for job pods (issue #1283): pods kept in memory; `onCreate` plays what the pod does once it runs.
import type { KubernetesPods, PodManifest, PodState } from '../../src/domain/pods.ts';

export interface FakeKubernetes extends KubernetesPods {
  /** Every pod created, in order. */
  created: PodManifest[];
  /** Every pod deleted, by name, in order. */
  removed: string[];
  /** The pods there now, by name. */
  pods: Map<string, PodState>;
}

export function createFakeKubernetes(o: { namespace?: string; onCreate?: (pod: PodManifest) => void | Promise<void>; onRemove?: (name: string) => void | Promise<void>; problem?: () => string | undefined } = {}): FakeKubernetes {
  const created: PodManifest[] = [];
  const removed: string[] = [];
  const pods = new Map<string, PodState>();
  const nameOf = (p: PodManifest): string => String((p.metadata as { name?: unknown } | undefined)?.name);
  return {
    namespace: o.namespace ?? 'hopper', created, removed, pods,
    problem: async () => o.problem?.(),
    async create(pod) {
      const name = nameOf(pod);
      if (pods.has(name)) throw new Error(`409 pods "${name}" already exists`);
      created.push(pod);
      pods.set(name, { phase: 'Running' });
      await o.onCreate?.(pod);
    },
    state: async (name) => pods.get(name),
    async remove(name) {
      if (!pods.delete(name)) return;
      removed.push(name);
      await o.onRemove?.(name);
    },
    list: async (labels) => created.filter((p) => pods.has(nameOf(p)) && Object.entries(labels).every(([k, v]) => (p.metadata as { labels: Record<string, string> }).labels[k] === v)).map(nameOf),
  };
}

/** The env value `name` of a pod's job container. */
export function podEnv(pod: PodManifest, name: string): string | undefined {
  const c = (pod.spec as { containers: { env?: { name: string; value: string }[] }[] }).containers[0];
  return c?.env?.find((e) => e.name === name)?.value;
}
