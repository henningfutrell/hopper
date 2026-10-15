// The kubernetes executor (issue #1283): its job runs on the job pod's machine, its credentials are placed there and
// never on the lane's machine, and its cleanup deletes the pod — without the pane's close when the pod is gone.
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, Executor } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createKubernetesExecutor } from '../../src/executors/kubernetes.ts';
import type { JobPods } from '../../src/kubernetes/job-pods.ts';

const cluster: MachineSnapshot = { id: 'cluster', label: 'cluster', maxLanes: 2, online: true, executors: ['kubernetes'] };
const pod: MachineSnapshot = { id: 'hopper-job-j1', label: 'hopper-job-j1', maxLanes: 1, online: true, executors: [], client: {} };
const job = { id: 'j1' } as Job;

function setup(o: { alive?: boolean } = {}) {
  const calls: string[] = [];
  const seen: { machine?: string; credentialsOn?: string } = {};
  const inner: Executor = {
    name: 'herdr-claude', validate: () => null,
    async run(ctx) { seen.machine = ctx.machine.id; await ctx.credentials?.('/scratch'); return { kind: 'finished', result: {} }; },
    async resume(ctx) { seen.machine = ctx.machine.id; return { kind: 'finished', result: {} }; },
    async cleanup() { calls.push('inner cleanup'); },
    machineShell: (m) => (calls.push(`shell ${m.id}`), undefined),
  };
  const pods: JobPods = {
    start: async () => (calls.push('start'), { machine: pod }),
    machine: async () => (o.alive === false ? undefined : pod),
    alive: async () => o.alive !== false,
    remove: async () => { calls.push('remove'); },
  };
  const ctx = {
    job, laneId: 'cluster/lane-1', machine: cluster, signal: new AbortController().signal, progress: () => undefined, saveState: () => undefined, workTree: () => undefined,
    credentials: async (_s: string, _m?: boolean, on?: MachineSnapshot) => { seen.credentialsOn = (on ?? cluster).id; return {}; },
  } as unknown as ExecutionContext;
  return { calls, seen, ctx, executor: createKubernetesExecutor('kubernetes', inner, pods) };
}

describe('the kubernetes executor', () => {
  it('runs the job on its pod\'s machine, its credentials placed there', async () => {
    const s = setup();
    expect(await s.executor.run(s.ctx)).toEqual({ kind: 'finished', result: {} });
    expect(s.seen).toEqual({ machine: 'hopper-job-j1', credentialsOn: 'hopper-job-j1' });
    expect(s.calls).toEqual(['start']);
  });

  it('cleans up: the pane closed in the pod, then the pod deleted', async () => {
    const s = setup();
    await s.executor.cleanup!(job);
    expect(s.calls).toEqual(['inner cleanup', 'remove']);
  });

  it('a pod that is gone is deleted without a close it could never reach, and a resume fails', async () => {
    const s = setup({ alive: false });
    await s.executor.cleanup!(job);
    expect(s.calls).toEqual(['remove']);
    expect(await s.executor.resume!(s.ctx, 'yes')).toMatchObject({ kind: 'failed', error: expect.stringMatching(/pod is gone/) });
  });

  it('reaches a pod\'s machine for the sweep, and never the cluster itself', () => {
    const s = setup();
    s.executor.machineShell!(cluster);
    s.executor.machineShell!(pod);
    expect(s.calls).toEqual(['shell hopper-job-j1']);
  });
});
