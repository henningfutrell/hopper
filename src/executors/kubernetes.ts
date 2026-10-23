// The kubernetes executor (issue #1283, design.md "Job pods on Kubernetes"): each job in a pod of its own. It starts the
// job's pod (src/kubernetes/job-pods.ts), and the job then runs in the pod's herdr, as herdr-claude runs a job on any
// client target: `inner` is that herdr-claude, given the pod's machine in place of the lane's. Everything after the start
// — resume, reattach, the pane probes, park — reaches the pod through the pane state herdr-claude saved, which names
// the pod's machine. The cleanup deletes the pod; a cancel aborts the run, and the engine's cleanup follows.
//
// The agent's sign-in (issue #1287, design.md "The agent's sign-in in a job pod"): before each start of a pane in the
// pod — a run, a resume —, the job's user's vault gives their Claude setup token, and the pane starts with it as
// CLAUDE_CODE_OAUTH_TOKEN. It goes over the pod's signed link with the pane's other variables, never into the pod's
// spec, and no outcome carries it.
import { AGENT_CREDENTIAL_VARIABLE } from '../domain/agent-credential.ts';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { JobPods } from '../kubernetes/job-pods.ts';
import { jobPodName } from '../kubernetes/pod-spec.ts';
import { maskSecret } from '../secrets/mask.ts';

/** The job's user's agent credential for its pod: the secret's name and value, none, or why the vault refuses it. */
export type PodCredential = (jobId: string, pod: string) => Promise<{ name: string; value: string } | { none: true } | { refused: string }>;

type Given = { name: string; value: string } | undefined;

export function createKubernetesExecutor(name: string, inner: Executor, pods: JobPods, credential?: PodCredential): Executor {
  /** The lane's context on the pod's machine: the job's credentials placed there too, never on the lane's machine; the agent's sign-in with them. */
  const on = (ctx: ExecutionContext, machine: MachineSnapshot, given: Given): ExecutionContext => ({
    ...ctx, machine,
    credentials: async (scratch: string, make?: boolean) => ({
      ...(await ctx.credentials?.(scratch, make, machine)), ...(given ? { [AGENT_CREDENTIAL_VARIABLE]: given.value } : {}),
    }),
  });

  /** The agent credential for the job's pod: given, none, or the outcome that fails the job. */
  async function agentCredential(job: Job): Promise<Given | ExecutionOutcome> {
    if (!credential) return undefined;
    const r = await credential(job.id, jobPodName(job.id));
    if ('refused' in r) return { kind: 'failed', error: `the agent credential: ${r.refused}` };
    return 'none' in r ? undefined : r;
  }

  /** `outcome` with the token never in it: a tool's error may repeat the pane's variables. */
  const masked = (outcome: ExecutionOutcome, given: Given): ExecutionOutcome => {
    if (!given || outcome.kind !== 'failed') return outcome;
    const mask = (text: string): string => maskSecret(text, given.value, given.name);
    return { ...outcome, error: mask(outcome.error), ...(outcome.tail !== undefined ? { tail: mask(outcome.tail) } : {}) };
  };

  const isOutcome = (g: Given | ExecutionOutcome): g is ExecutionOutcome => g !== undefined && 'kind' in g;

  /**
   * The lane's context, on the job's pod's machine; or why the job cannot go on there. `signIn`: a new pane may start
   * there (a resume), so the agent's sign-in is asked for; a reattach watches the pane it has.
   */
  async function onPod(ctx: ExecutionContext, signIn: boolean): Promise<{ ctx: ExecutionContext; given: Given } | ExecutionOutcome> {
    const machine = await pods.machine(ctx.job.id).catch(() => undefined);
    if (!machine?.online) return { kind: 'failed', error: `the job's pod is gone or not dialled in: it cannot go on there` };
    const given = signIn ? await agentCredential(ctx.job) : undefined;
    if (isOutcome(given)) return given;
    return { ctx: on(ctx, machine, given), given };
  }

  return {
    name,
    idempotent: false,
    ...(inner.reviews ? { reviews: true as const } : {}),
    validate: (payload) => inner.validate(payload),

    async run(ctx) {
      // Asked before the pod starts: a refusal starts no pod.
      const given = await agentCredential(ctx.job);
      if (isOutcome(given)) return given;
      const started = await pods.start(ctx.job.id, ctx.signal, (m) => ctx.progress(m));
      if ('failed' in started) return { kind: 'failed', error: started.failed };
      return masked(await inner.run(on(ctx, started.machine, given)), given);
    },

    ...(inner.resume ? {
      async resume(ctx: ExecutionContext, answer: string) {
        const there = await onPod(ctx, true);
        return 'kind' in there ? there : masked(await inner.resume!(there.ctx, answer), there.given);
      },
    } : {}),

    ...(inner.reattach && inner.canReattach ? {
      // A pod that is gone has nothing to reattach to: the job is cleaned up and failed.
      canReattach: async (job: Job) => (await pods.alive(job.id)) && inner.canReattach!(job),
      async reattach(ctx: ExecutionContext) {
        const there = await onPod(ctx, false);
        return 'kind' in there ? there : inner.reattach!(there.ctx);
      },
    } : {}),

    ...(inner.answeredInPane ? { answeredInPane: (job: Job) => inner.answeredInPane!(job) } : {}),
    ...(inner.ownCommandRuns ? { ownCommandRuns: (job: Job) => inner.ownCommandRuns!(job) } : {}),
    ...(inner.nudgeInPane ? { nudgeInPane: (job: Job, text: string) => inner.nudgeInPane!(job, text) } : {}),
    ...(inner.park ? { park: (job: Job) => inner.park!(job) } : {}),
    ...(inner.checkpoint ? { checkpoint: (job: Job) => inner.checkpoint!(job) } : {}),

    async cleanup(job, o) {
      // The pane's close and the reap need the pod; a pod that is gone left nothing to close or reap.
      const alive = await pods.alive(job.id);
      const reaped = alive ? await inner.cleanup?.(job, o) : undefined;
      await pods.remove(job.id);
      return reaped ?? undefined;
    },

    // A pod's machine is a client target: reached as herdr-claude reaches one (the job's credentials, the sweep). The
    // lane's machine, the cluster, is no machine any command runs on.
    machineShell: (machine) => (machine.client ? inner.machineShell?.(machine) : undefined),
    // A pod whose job ended and no cleanup deleted (issue #1570).
    sweep: (ended) => pods.sweep(ended),
  };
}
