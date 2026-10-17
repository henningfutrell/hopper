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
const TOKEN = 'sk-ant-oat01-pod-credential-0123456789';

type Answer = { name: string; value: string } | { none: true } | { refused: string };

function setup(o: { alive?: boolean; credential?: Answer; fails?: string } = {}) {
  const calls: string[] = [];
  const seen: { machine?: string; credentialsOn?: string; env?: Readonly<Record<string, string>> } = {};
  const inner: Executor = {
    name: 'herdr-claude', validate: () => null,
    async run(ctx) {
      seen.machine = ctx.machine.id; seen.env = await ctx.credentials?.('/scratch');
      return o.fails ? { kind: 'failed', error: o.fails } : { kind: 'finished', result: {} };
    },
    async resume(ctx) { seen.machine = ctx.machine.id; seen.env = await ctx.credentials?.('/scratch'); return { kind: 'finished', result: {} }; },
    async cleanup() { calls.push('inner cleanup'); },
    machineShell: (m) => (calls.push(`shell ${m.id}`), undefined),
  };
  const pods: JobPods = {
    start: async () => (calls.push('start'), { machine: pod }),
    machine: async () => (o.alive === false ? undefined : pod),
    alive: async () => o.alive !== false,
    remove: async () => { calls.push('remove'); },
    sweep: async () => [],
  };
  const ctx = {
    job, laneId: 'cluster/lane-1', machine: cluster, signal: new AbortController().signal, progress: () => undefined, saveState: () => undefined, workTree: () => undefined,
    credentials: async (_s: string, _m?: boolean, on?: MachineSnapshot) => { seen.credentialsOn = (on ?? cluster).id; return { HOPPER_URL: 'http://hopper' }; },
  } as unknown as ExecutionContext;
  const credential = o.credential ? async (jobId: string, podName: string) => (calls.push(`credential ${jobId} ${podName}`), o.credential!) : undefined;
  return { calls, seen, ctx, executor: createKubernetesExecutor('kubernetes', inner, pods, credential) };
}

describe('the kubernetes executor', () => {
  it('runs the job on its pod\'s machine, its credentials placed there', async () => {
    const s = setup();
    expect(await s.executor.run(s.ctx)).toEqual({ kind: 'finished', result: {} });
    expect(s.seen).toEqual({ machine: 'hopper-job-j1', credentialsOn: 'hopper-job-j1', env: { HOPPER_URL: 'http://hopper' } });
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

  // Issue #1287: the agent's sign-in from the vault, given to the pane on the pod at each start, never in the pod's spec.
  it('gives the pod\'s pane the user\'s Claude token, asked of the vault before the pod starts', async () => {
    const s = setup({ credential: { name: 'CLAUDE_TOKEN', value: TOKEN } });
    expect(await s.executor.run(s.ctx)).toEqual({ kind: 'finished', result: {} });
    expect(s.calls).toEqual(['credential j1 hopper-job-j1', 'start']);
    expect(s.seen.env).toEqual({ HOPPER_URL: 'http://hopper', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('asks again at a resume, so a new pane in the pod is signed in too', async () => {
    const s = setup({ credential: { name: 'CLAUDE_TOKEN', value: TOKEN } });
    await s.executor.resume!(s.ctx, 'yes');
    expect(s.calls).toEqual(['credential j1 hopper-job-j1']);
    expect(s.seen.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('with no token in the vault, the pane gets none: Claude asks to sign in, as on any fresh machine', async () => {
    const s = setup({ credential: { none: true } });
    await s.executor.run(s.ctx);
    expect(s.seen.env).toEqual({ HOPPER_URL: 'http://hopper' });
  });

  it('a refusal fails the job before any pod starts', async () => {
    const s = setup({ credential: { refused: 'CLAUDE_TOKEN is not a Claude token' } });
    expect(await s.executor.run(s.ctx)).toEqual({ kind: 'failed', error: 'the agent credential: CLAUDE_TOKEN is not a Claude token' });
    expect(s.calls).toEqual(['credential j1 hopper-job-j1']);
  });

  it('never lets the token out in an outcome', async () => {
    const s = setup({ credential: { name: 'CLAUDE_TOKEN', value: TOKEN }, fails: `herdr: Command failed: herdr tab create --env CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}` });
    const out = await s.executor.run(s.ctx);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out).toEqual({ kind: 'failed', error: 'herdr: Command failed: herdr tab create --env CLAUDE_CODE_OAUTH_TOKEN=[CLAUDE_TOKEN, masked]' });
  });
});
