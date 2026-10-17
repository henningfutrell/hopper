// One pod per job (issue #1283, design.md "Job pods on Kubernetes"): the pod is started through the Kubernetes API with a
// one-time join line, joins as a client target named after it — a machine only its job runs on —, and dials out to the
// hopper. The job runs there as on any client target. When the job ends, or its start fails or is cancelled, the pod is
// deleted and its machine removed. The sweep (issue #1570) deletes this hopper's pods whose job ended, which a stop of the
// hopper between the job's end and its cleanup, or a delete that failed, left.
import { POD_INSTANCE_LABEL, type KubernetesPods } from '../domain/pods.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { JOB_POD_PREFIX, jobPod, jobPodName, labelValue, type WorkVolume } from './pod-spec.ts';

export interface JobPodsOptions {
  pods: KubernetesPods;
  /** The hopper's instance id: the label that makes a pod this hopper's. */
  instanceId: () => string;
  image: string;
  /** The hopper's URL as a pod reaches it (its Service in the cluster): what the pod dials. */
  hopperUrl: string;
  volume: WorkVolume;
  cpus: number;
  memoryMb: number;
  pullSecret?: string;
  /** A fresh join code for the job's user that names this pod (issue #1283): the pod joins once with it. */
  join(pod: string): string;
  /** The machine a pod joined as, by its name; undefined until it joined. */
  machine(name: string): Promise<MachineSnapshot | undefined>;
  /** Removes the client target the pod joined as; none is no error. */
  leave(pod: string): Promise<void>;
  /** How long a pod may take to join and come online. */
  startTimeoutMs: number;
  pollMs: number;
  /** Resolves true after `ms`, false as soon as the signal fires. */
  sleep(ms: number, signal: AbortSignal): Promise<boolean>;
  now: () => number;
}

export interface JobPods {
  /** Starts the job's pod and waits until it joined and is online: its machine; or why not, its pod deleted again. */
  start(jobId: string, signal: AbortSignal, progress?: (message: string) => void): Promise<{ machine: MachineSnapshot } | { failed: string }>;
  /** The job's pod's machine now; undefined while it has not joined, or is gone. */
  machine(jobId: string): Promise<MachineSnapshot | undefined>;
  /** Whether the job's pod is there and has not ended. Rejects when the API cannot tell. */
  alive(jobId: string): Promise<boolean>;
  /** Deletes the job's pod and removes its machine. Idempotent; rejects when the API refused the delete. */
  remove(jobId: string): Promise<void>;
  /** Removes each pod of this hopper (its instance label) whose job `ended` says ended, with its machine: those jobs. */
  sweep(ended: (jobId: string) => boolean): Promise<string[]>;
}


export function createJobPods(o: JobPodsOptions): JobPods {
  const url = new URL(o.hopperUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`hopperUrl must be an http or https URL: ${o.hopperUrl}`);

  async function remove(jobId: string): Promise<void> {
    const name = jobPodName(jobId);
    await o.pods.remove(name);
    await o.leave(name);
  }

  async function start(jobId: string, signal: AbortSignal, progress?: (message: string) => void): Promise<{ machine: MachineSnapshot } | { failed: string }> {
    const name = jobPodName(jobId);
    // A pod left from an earlier start of this job (a restart while it started) is not this start's.
    await remove(jobId);
    const code = o.join(name);
    try {
      await o.pods.create(jobPod({
        name, jobId, instanceId: o.instanceId(), image: o.image, joinLine: `${url.origin}#${code}`, volume: o.volume, cpus: o.cpus, memoryMb: o.memoryMb,
        ...(o.pullSecret ? { pullSecret: o.pullSecret } : {}),
      }));
    } catch (e) {
      return { failed: `pod ${name} was not created in namespace ${o.pods.namespace}: ${(e as Error).message}` };
    }
    progress?.(`started pod ${name} in namespace ${o.pods.namespace}`);
    const until = o.now() + o.startTimeoutMs;
    const gone = async (failed: string): Promise<{ failed: string }> => {
      await remove(jobId).catch(() => undefined);
      return { failed };
    };
    for (;;) {
      if (signal.aborted) return gone('aborted');
      const state = await o.pods.state(name).catch(() => undefined);
      if (state && (state.phase === 'Failed' || state.phase === 'Succeeded')) {
        return gone(`pod ${name} ended before its job started (${state.phase}${state.reason ? `: ${state.reason}` : ''})`);
      }
      const machine = await o.machine(name);
      if (machine?.online) {
        progress?.(`pod ${name} joined and is online`);
        return { machine };
      }
      if (o.now() >= until) return gone(`pod ${name} did not join the hopper within ${Math.round(o.startTimeoutMs / 1000)} s (${state ? state.phase : 'no pod'}${state?.reason ? `: ${state.reason}` : ''}): check that it reaches ${url.origin}`);
      if (!(await o.sleep(o.pollMs, signal))) return gone('aborted');
    }
  }

  return {
    start,
    machine: (jobId) => o.machine(jobPodName(jobId)),
    async alive(jobId) {
      const state = await o.pods.state(jobPodName(jobId));
      return state !== undefined && state.phase !== 'Failed' && state.phase !== 'Succeeded';
    },
    remove,
    async sweep(ended) {
      const out: string[] = [];
      for (const name of await o.pods.list({ [POD_INSTANCE_LABEL]: labelValue(o.instanceId()) })) {
        const jobId = name.startsWith(JOB_POD_PREFIX) ? name.slice(JOB_POD_PREFIX.length) : '';
        if (!jobId || !ended(jobId)) continue;
        await remove(jobId);
        out.push(jobId);
      }
      return out;
    },
  };
}
