// One pod per job (issue #1283): started with a one-time join line, waited on until it joined and is online, and deleted
// — its machine removed — when its start fails, is cancelled, or the job ends.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createJobPods, type JobPodsOptions } from '../../src/kubernetes/job-pods.ts';
import { createFakeKubernetes, podEnv, type FakeKubernetes } from '../support/fake-kubernetes.ts';

const JOB = '0f8e3c2a-1111-4222-8333-444455556666';
const POD = `hopper-job-${JOB}`;

function setup(o: { joins?: boolean; fake?: FakeKubernetes; startTimeoutMs?: number } = {}) {
  const fake = o.fake ?? createFakeKubernetes();
  const joined = new Map<string, MachineSnapshot>();
  const left: string[] = [];
  const codes: string[] = [];
  let now = 0;
  const opts: JobPodsOptions = {
    pods: fake, instanceId: () => 'inst-1', image: 'box:claude', hopperUrl: 'http://hopper.hopper.svc:4790/ui', volume: { emptyDir: {} }, cpus: 1, memoryMb: 1024,
    join: (pod) => { codes.push(pod); return 'c'.repeat(64); },
    machine: async (name) => joined.get(name),
    leave: async (pod) => { left.push(pod); joined.delete(pod); },
    startTimeoutMs: o.startTimeoutMs ?? 10_000, pollMs: 1000, now: () => now,
    sleep: async (ms, signal) => { now += ms; if (o.joins !== false && fake.pods.has(POD)) joined.set(POD, { id: POD, label: POD, maxLanes: 1, online: true, executors: [], client: {} }); return !signal.aborted; },
  };
  return { fake, joined, left, codes, pods: createJobPods(opts), advance: (ms: number) => { now += ms; } };
}

describe('a job pod', () => {
  it('starts with the job\'s join line to the hopper\'s URL, and is the job\'s machine once it joined and is online', async () => {
    const s = setup();
    const said: string[] = [];
    const r = await s.pods.start(JOB, new AbortController().signal, (m) => said.push(m));
    expect(r).toMatchObject({ machine: { id: POD, online: true } });
    expect(s.codes).toEqual([POD]);
    expect(podEnv(s.fake.created[0]!, 'HOPPER_JOIN')).toBe(`http://hopper.hopper.svc:4790#${'c'.repeat(64)}`);
    expect(said).toEqual([`started pod ${POD} in namespace hopper`, `pod ${POD} joined and is online`]);
    expect(await s.pods.alive(JOB)).toBe(true);
  });

  it('is deleted, and its machine removed, when the job ends: twice is no error', async () => {
    const s = setup();
    await s.pods.start(JOB, new AbortController().signal);
    await s.pods.remove(JOB);
    await s.pods.remove(JOB);
    expect(s.fake.removed).toEqual([POD]);
    expect(s.left).toContain(POD);
    expect(await s.pods.alive(JOB)).toBe(false);
    expect(await s.pods.machine(JOB)).toBeUndefined();
  });

  it('a cancel while it starts deletes the pod', async () => {
    const s = setup({ joins: false });
    const ac = new AbortController();
    const started = s.pods.start(JOB, ac.signal);
    ac.abort('cancel');
    expect(await started).toEqual({ failed: 'aborted' });
    expect(s.fake.pods.has(POD)).toBe(false);
    expect(s.fake.removed).toEqual([POD]);
  });

  it('a pod that never joins is deleted at the start limit, and the job is told what to check', async () => {
    const s = setup({ joins: false, startTimeoutMs: 5000 });
    const r = await s.pods.start(JOB, new AbortController().signal);
    expect(r).toEqual({ failed: expect.stringMatching(new RegExp(`pod ${POD} did not join the hopper within 5 s \\(Running\\): check that it reaches http://hopper.hopper.svc:4790`)) });
    expect(s.fake.pods.has(POD)).toBe(false);
  });

  it('a pod that ends before it joined is deleted, with its reason', async () => {
    const fake = createFakeKubernetes({ onCreate: (p) => { fake.pods.set(String((p.metadata as { name: string }).name), { phase: 'Failed', reason: 'ErrImagePull' }); } });
    const s = setup({ fake, joins: false });
    expect(await s.pods.start(JOB, new AbortController().signal)).toEqual({ failed: `pod ${POD} ended before its job started (Failed: ErrImagePull)` });
    expect(fake.removed).toEqual([POD]);
  });

  it('a pod the API does not create fails the start with the API\'s reason', async () => {
    const fake = createFakeKubernetes();
    fake.create = async () => { throw new Error('403 pods is forbidden'); };
    const s = setup({ fake });
    expect(await s.pods.start(JOB, new AbortController().signal)).toEqual({ failed: `pod ${POD} was not created in namespace hopper: 403 pods is forbidden` });
  });

  it('a pod left from an earlier start of the job is deleted before the new one starts', async () => {
    const s = setup();
    await s.pods.start(JOB, new AbortController().signal);
    await s.pods.start(JOB, new AbortController().signal);
    expect(s.fake.created).toHaveLength(2);
    expect(s.fake.removed).toEqual([POD]);
  });
});
