// The kubernetes executor (issue #1283, design.md "Job pods on Kubernetes"): each job in a pod of its own. It starts the
// job's pod (src/kubernetes/job-pods.ts), and the job then runs in the pod's herdr, as herdr-claude runs a job on any
// client target: `inner` is that herdr-claude, given the pod's machine in place of the lane's. Everything after the start
// — resume, reattach, the pane probes, park — reaches the pod through the pane state herdr-claude saved, which names
// the pod's machine. The cleanup deletes the pod; a cancel aborts the run, and the engine's cleanup follows.
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { JobPods } from '../kubernetes/job-pods.ts';

export function createKubernetesExecutor(name: string, inner: Executor, pods: JobPods): Executor {
  /** The lane's context on the pod's machine: the job's credentials placed there too, never on the lane's machine. */
  const on = (ctx: ExecutionContext, machine: MachineSnapshot): ExecutionContext => ({
    ...ctx, machine, ...(ctx.credentials ? { credentials: (scratch: string, make?: boolean) => ctx.credentials!(scratch, make, machine) } : {}),
  });

  /** The lane's context, on the job's pod's machine; or why the job cannot go on there. */
  async function onPod(ctx: ExecutionContext): Promise<ExecutionContext | ExecutionOutcome> {
    const machine = await pods.machine(ctx.job.id).catch(() => undefined);
    if (!machine?.online) return { kind: 'failed', error: `the job's pod is gone or not dialled in: it cannot go on there` };
    return on(ctx, machine);
  }

  return {
    name,
    idempotent: false,
    ...(inner.reviews ? { reviews: true as const } : {}),
    validate: (payload) => inner.validate(payload),

    async run(ctx) {
      const started = await pods.start(ctx.job.id, ctx.signal, (m) => ctx.progress(m));
      if ('failed' in started) return { kind: 'failed', error: started.failed };
      return inner.run(on(ctx, started.machine));
    },

    ...(inner.resume ? {
      async resume(ctx: ExecutionContext, answer: string) {
        const there = await onPod(ctx);
        return 'kind' in there ? there : inner.resume!(there, answer);
      },
    } : {}),

    ...(inner.reattach && inner.canReattach ? {
      // A pod that is gone has nothing to reattach to: the job is cleaned up and failed.
      canReattach: async (job: Job) => (await pods.alive(job.id)) && inner.canReattach!(job),
      async reattach(ctx: ExecutionContext) {
        const there = await onPod(ctx);
        return 'kind' in there ? there : inner.reattach!(there);
      },
    } : {}),

    ...(inner.answeredInPane ? { answeredInPane: (job: Job) => inner.answeredInPane!(job) } : {}),
    ...(inner.ownCommandRuns ? { ownCommandRuns: (job: Job) => inner.ownCommandRuns!(job) } : {}),
    ...(inner.nudgeInPane ? { nudgeInPane: (job: Job, text: string) => inner.nudgeInPane!(job, text) } : {}),
    ...(inner.park ? { park: (job: Job) => inner.park!(job) } : {}),
    ...(inner.checkpoint ? { checkpoint: (job: Job) => inner.checkpoint!(job) } : {}),

    async cleanup(job) {
      // The pane's close and the reap need the pod; a pod that is gone left nothing to close or reap.
      const alive = await pods.alive(job.id);
      const reaped = alive ? await inner.cleanup?.(job) : undefined;
      await pods.remove(job.id);
      return reaped ?? undefined;
    },

    // A pod's machine is a client target: reached as herdr-claude reaches one (the job's credentials, the sweep). The
    // lane's machine, the cluster, is no machine any command runs on.
    machineShell: (machine) => (machine.client ? inner.machineShell?.(machine) : undefined),
  };
}
