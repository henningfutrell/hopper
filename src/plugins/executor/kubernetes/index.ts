// kubernetes: each job in a pod of its own, started through the Kubernetes API in the hopper's namespace (issue #1283,
// design.md "Job pods on Kubernetes"). The pod runs the sandbox box's image — herdr and Claude Code as its unprivileged
// user, its home on an emptyDir or a claim —, joins with a one-time join line and dials out; no sshd and no port in it.
// The job runs in the pod's herdr as herdr-claude runs one on a client target; the pod is deleted when the job ends.
import { createKubernetesExecutor } from '../../../executors/kubernetes.ts';
import { createKubernetesPods, inClusterOptions } from '../../../kubernetes/api.ts';
import { createJobPods } from '../../../kubernetes/job-pods.ts';
import { JOB_POD_IMAGE } from '../../../kubernetes/pod-spec.ts';
import type { KubernetesPods } from '../../../domain/pods.ts';
import { parseOptions } from '../../options.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { herdrClaudePlugin, type HerdrClaudeOptions } from '../herdr-claude/index.ts';

export interface KubernetesExecutorOptions {
  hopperUrl: string;
  namespace?: string;
  image: string;
  pullSecret?: string;
  claim?: string;
  emptyDirGiB?: number;
  cpus: number;
  memoryMb: number;
  startTimeoutSec: number;
  pollMs: number;
  yolo: boolean;
  args: string[];
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => {
  if (signal.aborted) { resolve(false); return; }
  const done = (): void => { clearTimeout(timer); resolve(false); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(true); }, ms);
  signal.addEventListener('abort', done, { once: true });
});

/**
 * The plugin. `seams` (tests): the Kubernetes API, and herdr-claude's own seam in the pod. Without them, the API is the
 * one the hopper's own pod reaches with its service account.
 */
export function kubernetesPlugin(seams?: { pods?: (namespace?: string) => KubernetesPods; herdr?: Parameters<typeof herdrClaudePlugin>[0] }): PluginDefinition<'executor', KubernetesExecutorOptions> {
  const podsIn = (env: (name: string) => string | undefined, namespace?: string): KubernetesPods =>
    seams?.pods?.(namespace) ?? createKubernetesPods(inClusterOptions(env, undefined, namespace));
  return {
    id: 'kubernetes',
    role: 'executor',
    describe: 'Claude Code in a pod of its own per job, started through the Kubernetes API in the hopper\'s namespace; the pod dials out to the hopper',
    options: (z) => z.strictObject({
      hopperUrl: z.string().url().refine((s) => /^https?:\/\//.test(s), 'hopperUrl must be an http or https URL')
        .meta({ commandBearing: true, description: 'the hopper\'s URL as a job pod reaches it, as http://<its Service>.<namespace>.svc:<port>: what the pod dials. Its host must be one of the hopper\'s LAN names' }),
      namespace: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional()
        .meta({ commandBearing: true, description: 'where job pods run. Absent: the hopper\'s own namespace. The hopper\'s role may manage pods there and nothing else' }),
      image: z.string().min(1).default(JOB_POD_IMAGE).meta({ commandBearing: true, description: 'a job pod\'s image: the sandbox box\'s (herdr, Claude Code and the hopper client, no sshd)' }),
      pullSecret: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/).optional().meta({ commandBearing: true, description: 'the image pull secret in that namespace, when the image needs one' }),
      claim: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/).optional()
        .meta({ commandBearing: true, description: 'a persistent volume claim for the job pods\' homes, where their work trees live: each pod a directory of its own on it. Absent: an emptyDir, gone with the pod' }),
      emptyDirGiB: z.number().positive().optional().meta({ description: 'the emptyDir\'s size limit, in GiB, when no claim is named' }),
      cpus: z.number().positive().max(64).default(2).meta({ description: 'CPUs a job pod asks for and may use' }),
      memoryMb: z.number().int().min(512).max(262144).default(4096).meta({ description: 'memory a job pod asks for and may use, in MiB' }),
      startTimeoutSec: z.number().int().min(10).max(3600).default(300).meta({ description: 'how long a job pod may take to start, join and come online before its job fails' }),
      pollMs: z.number().int().positive().default(2000),
      yolo: z.boolean().default(true).meta({ commandBearing: true, description: 'yolo: Claude runs with every permission granted (--dangerously-skip-permissions)' }),
      args: z.array(z.string()).default([]).meta({ commandBearing: true, description: "Claude Code's other arguments" }),
    }),
    async detect(sys, o) {
      if (seams?.pods) return { status: 'available', detail: 'Kubernetes API seam (tests)' };
      let pods: KubernetesPods;
      try { pods = podsIn(sys.env, o.namespace); } catch (e) { return { status: 'unavailable', reason: (e as Error).message }; }
      const problem = await pods.problem();
      return problem ? { status: 'unavailable', reason: problem } : { status: 'available', detail: `pods in namespace ${pods.namespace}` };
    },
    create(ctx, o) {
      if (!ctx.pods || !ctx.machine) throw new Error('this hopper cannot take job pods: it has no join codes for them');
      const host = ctx.pods, machineOf = ctx.machine;
      const parsed = parseOptions(herdrClaudePlugin(), { yolo: o.yolo, args: o.args });
      if (!parsed.ok) throw new Error(parsed.error);
      const inner = herdrClaudePlugin(seams?.herdr).create(ctx, parsed.options as unknown as HerdrClaudeOptions);
      const pods = podsIn(ctx.env, o.namespace);
      const jobPods = createJobPods({
        pods, instanceId: () => host.instanceId(), image: o.image, hopperUrl: o.hopperUrl,
        volume: o.claim ? { claim: o.claim } : { emptyDir: o.emptyDirGiB ? { sizeLimitGiB: o.emptyDirGiB } : {} },
        cpus: o.cpus, memoryMb: o.memoryMb, ...(o.pullSecret ? { pullSecret: o.pullSecret } : {}),
        join: (pod) => host.join(pod), leave: (pod) => host.leave(pod), machine: machineOf,
        startTimeoutMs: o.startTimeoutSec * 1000, pollMs: o.pollMs, sleep: abortableSleep, now: () => ctx.clock.now().getTime(),
      });
      return Promise.resolve(inner).then((executor) => createKubernetesExecutor(ctx.instanceName, executor, jobPods));
    },
  };
}

export default kubernetesPlugin();
