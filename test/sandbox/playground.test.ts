// Issue #1410: the sandbox playground starts many sandboxes at once within the hopper's limits, lists them and destroys
// them, and leaves nothing behind: on destroy, at the time limit, and after a restart. On the Kubernetes runtime over an
// in-memory API (test/support/fake-kube-api.ts), and on the container runtime double (Podman's port).
//
// Feature: the sandbox playground
//   Scenario: 50 sandboxes with maxConcurrent 20 start 20 and refuse the rest, naming the limit
//   Scenario: destroy-all leaves no sandbox pod or claim in the namespace
//   Scenario: a sandbox past its time limit is destroyed, with its claim
//   Scenario: a hopper restart removes every playground sandbox it left
//   Scenario: none fits: the create is refused with 429, naming the limit; maxPerUser holds one user only
//   Scenario: a size over the hopper's max or the template's is refused with 400, and nothing starts
//   Scenario: a sandbox that does not start leaves nothing, and is shown failed; it holds no room
//   Scenario: a home volume that is there already is not used, and stays as it is
//   Scenario: destroy takes one or a selection, and only the user's own
//   Scenario: a playground sandbox gets no join code: it runs idle, with no secret
//   Scenario: the sweep never touches a box that is not the playground's
import { describe, expect, it } from 'vitest';
import type { ContainerRuntime } from '../../src/domain/sandboxes.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createKubernetesRuntime, POD_LABEL } from '../../src/sandbox/kubernetes.ts';
import { createPlayground, IDLE_SCRIPT, PLAYGROUND_LABEL, PLAYGROUND_LIMITS, PlaygroundRefused, type PlaygroundLimits } from '../../src/sandbox/playground.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeKubeApi, type FakeKubeApi } from '../support/fake-kube-api.ts';

const hopper = { namespace: 'hopper', labels: { 'app.kubernetes.io/name': 'hopper' }, port: 4790 };
const logger = { info: () => {}, warn: () => {} };

/** The fake API, its pods running as soon as they are made. */
function cluster(): FakeKubeApi {
  const api = createFakeKubeApi();
  const create = api.createPod.bind(api);
  api.createPod = async (body) => {
    await create(body);
    api.phase((body.metadata as { name: string }).name, 'Running');
  };
  return api;
}

function playground(runtime: ContainerRuntime | undefined, limits: Partial<PlaygroundLimits> = {}, at = { now: new Date('2026-10-15T12:00:00Z') }) {
  return createPlayground({ runtime, noRuntime: 'no runtime', instanceId: 'inst1', network: 'hopper_default', limits: { ...PLAYGROUND_LIMITS, ...limits }, clock: { now: () => at.now }, logger });
}

const kube = (api: FakeKubeApi) => createKubernetesRuntime({ api, hopper, pollMs: 1, startMs: 1000 });
/** Waits until no sandbox of the user is starting. */
async function settled(p: ReturnType<typeof playground>, userId = 'u1'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (!(await p.view(userId)).sandboxes.some((s) => s.state === 'starting')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the sandboxes did not start');
}
const sandboxPods = (api: FakeKubeApi) => [...api.pods.values()].filter((x) => x.metadata?.labels?.[POD_LABEL] === 'true');
const sandboxClaims = (api: FakeKubeApi) => [...api.claims.values()].filter((c) => (c.metadata as { labels?: Record<string, string> }).labels?.[POD_LABEL] === 'claim');

const template = (over: Partial<TemplateView> = {}): TemplateView => ({
  name: 'kube', image: 'ghcr.io/henningfutrell/hopper:box-claude', approval: { by: 'admin', at: '2026-10-01T00:00:00Z' }, pending: { secrets: [], image: false, profiles: [] },
  gives: [], profiles: [], ...over,
} as unknown as TemplateView);

describe('the sandbox playground on Kubernetes', () => {
  it('50 sandboxes with maxConcurrent 20 start 20 and refuse the rest, naming the limit; destroy-all leaves nothing', async () => {
    const api = cluster();
    const p = playground(kube(api), { maxConcurrent: 20, maxPerUser: 50 });
    const created = p.create('u1', { count: 50, agent: 'claude', size: {} });
    expect(created.started).toHaveLength(20);
    expect(created.refused).toMatchObject({ count: 30, limit: 'maxConcurrent', setting: 'HOPPER_SANDBOX_MAX_CONCURRENT' });
    expect(created.refused!.reason).toContain('at most 20');
    await settled(p);

    const v = await p.view('u1');
    expect(v.running).toEqual({ all: 20, yours: 20 });
    expect(v.sandboxes.map((s) => s.state)).toEqual(Array(20).fill('running'));
    expect(sandboxPods(api)).toHaveLength(20);
    expect(sandboxClaims(api)).toHaveLength(20);
    // Each pod has the limits and the playground label, and runs idle.
    const pod = sandboxPods(api)[0]!;
    expect(pod.metadata?.labels?.[PLAYGROUND_LABEL]).toBe('inst1');
    expect(pod.spec?.containers[0]?.command).toEqual(['/bin/sh', '-c', IDLE_SCRIPT]);
    expect(pod.spec?.containers[0]?.resources?.limits).toEqual({ cpu: '1', memory: '2048Mi' });

    // More is refused while 20 run.
    expect(() => p.create('u1', { count: 1, agent: 'claude', size: {} })).toThrow(expect.objectContaining({ status: 429, limit: expect.objectContaining({ limit: 'maxConcurrent' }) }));

    const gone = await p.destroy('u1', 'all');
    expect(gone).toEqual({ destroyed: 20, problems: [] });
    expect(sandboxPods(api)).toEqual([]);
    expect(sandboxClaims(api)).toEqual([]);
    expect((await p.view('u1')).sandboxes).toEqual([]);
  });

  it('a sandbox past its time limit is destroyed, with its claim', async () => {
    const api = cluster();
    const at = { now: new Date('2026-10-15T12:00:00Z') };
    const p = playground(kube(api), {}, at);
    p.create('u1', { count: 2, agent: 'claude', size: { ttlMinutes: 30 } });
    p.create('u1', { count: 1, agent: 'claude', size: { ttlMinutes: 90 } });
    await settled(p);
    at.now = new Date('2026-10-15T12:31:00Z');
    await p.sweep();
    expect((await p.view('u1')).sandboxes.map((s) => s.size.ttlMinutes)).toEqual([90]);
    expect(sandboxPods(api)).toHaveLength(1);
    expect(sandboxClaims(api)).toHaveLength(1);
    at.now = new Date('2026-10-15T13:31:00Z');
    await p.sweep();
    expect(sandboxPods(api)).toEqual([]);
    expect(sandboxClaims(api)).toEqual([]);
  });

  it('a hopper restart removes every playground sandbox it left, and nothing else', async () => {
    const api = cluster();
    const before = playground(kube(api));
    before.create('u1', { count: 3, agent: 'claude', size: {} });
    await settled(before);
    // A job's box, made by the sandbox module: not the playground's.
    await kube(api).createVolume('hopper-sandbox-x-home', { 'io.hopper.box': 'inst1' });
    await kube(api).create({ name: 'hopper-sandbox-x', image: 'img', network: 'n', volume: 'hopper-sandbox-x-home', env: {}, labels: { 'io.hopper.box': 'inst1' }, limits: { cpus: 1, memoryMb: 1 }, user: '1000:1000' });
    // Another hopper's playground sandbox in the same namespace.
    await kube(api).create({ name: 'hopper-playground-other', image: 'img', network: 'n', volume: 'v', env: {}, labels: { [PLAYGROUND_LABEL]: 'inst2' }, limits: { cpus: 1, memoryMb: 1 }, user: '1000:1000' });
    expect(sandboxPods(api)).toHaveLength(5);

    const after = playground(kube(api));
    await after.start();
    await after.stop();
    expect(sandboxPods(api).map((x) => x.metadata?.name).sort()).toEqual(['hopper-playground-other', 'hopper-sandbox-x']);
    expect(sandboxClaims(api).map((c) => (c.metadata as { name: string }).name)).toEqual(['hopper-sandbox-x-home']);
  });
});

describe('the sandbox playground', () => {
  it('none fits: the create is refused with 429, naming the limit; maxPerUser holds one user only', async () => {
    const rt = createFakeContainerRuntime();
    const p = playground(rt, { maxConcurrent: 5, maxPerUser: 2 });
    const first = p.create('u1', { count: 3, agent: 'claude', size: {} });
    expect(first.started).toHaveLength(2);
    expect(first.refused).toMatchObject({ count: 1, limit: 'maxPerUser', setting: 'HOPPER_SANDBOX_MAX_PER_USER' });
    let refusal: unknown;
    try { p.create('u1', { count: 1, agent: 'claude', size: {} }); } catch (e) { refusal = e; }
    expect(refusal).toBeInstanceOf(PlaygroundRefused);
    expect(refusal).toMatchObject({ status: 429, limit: { limit: 'maxPerUser' } });
    // Another user still has room, up to the limit of all.
    expect(p.create('u2', { count: 2, agent: 'claude', size: {} }).started).toHaveLength(2);
    expect(p.create('u3', { count: 2, agent: 'claude', size: {} })).toMatchObject({ started: [expect.anything()], refused: { count: 1, limit: 'maxConcurrent' } });
    await settled(p, 'u1');
  });

  it('a size over the hopper\'s max or the template\'s is refused with 400, and nothing starts', async () => {
    const rt = createFakeContainerRuntime();
    const p = playground(rt, { max: { cpus: 2, memoryMb: 4096, ttlMinutes: 60 }, defaults: { cpus: 1, memoryMb: 1024, ttlMinutes: 30 } });
    expect(() => p.create('u1', { count: 1, agent: 'claude', size: { cpus: 3 } })).toThrow(/cpus 3 .*HOPPER_SANDBOX_MAX_CPUS.*at most 2/);
    expect(() => p.create('u1', { count: 1, agent: 'claude', size: { ttlMinutes: 61 } })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => p.create('u1', { count: 1, agent: 'claude', template: template({ limits: { memoryMb: { default: 512, max: 1024 } } }), size: { memoryMb: 2048 } }))
      .toThrow(/template kube allows: at most 1024/);
    expect(() => p.create('u1', { count: 1, agent: 'claude', template: template({ approval: undefined }), size: {} })).toThrow(expect.objectContaining({ status: 409 }));
    expect(rt.boxes.size).toBe(0);
    // The template's default fills what the create leaves out; the hopper's fills the rest.
    const made = p.create('u1', { count: 1, agent: 'claude', template: template({ limits: { memoryMb: { default: 512, max: 1024 } } }), size: {} });
    expect(made.started[0]).toMatchObject({ template: 'kube', size: { cpus: 1, memoryMb: 512, ttlMinutes: 30 } });
    await settled(p);
  });

  it('a sandbox that does not start leaves nothing, and is shown failed; it holds no room', async () => {
    const rt = createFakeContainerRuntime();
    rt.createFails = 'no space';
    const p = playground(rt, { maxConcurrent: 1 });
    p.create('u1', { count: 1, agent: 'claude', size: {} });
    await settled(p);
    const [s] = (await p.view('u1')).sandboxes;
    expect(s).toMatchObject({ state: 'failed' });
    expect(s!.problem).toContain('no space');
    expect(rt.boxes.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
    delete rt.createFails;
    expect(p.create('u1', { count: 1, agent: 'claude', size: {} }).started).toHaveLength(1);
    await settled(p);
    expect(rt.boxes.size).toBe(1);
  });

  it('a home volume that is there already is not used, and stays as it is', async () => {
    const rt = createFakeContainerRuntime();
    const id = '0123456789ab-cdef';
    const fixed = createPlayground({ runtime: rt, noRuntime: 'no runtime', instanceId: 'inst1', network: 'n', limits: PLAYGROUND_LIMITS, clock: { now: () => new Date() }, logger, newId: () => id });
    await rt.createVolume('hopper-playground-0123456789ab-home', { other: 'x' });
    fixed.create('u1', { count: 1, agent: 'claude', size: {} });
    await settled(fixed);
    const [s] = (await fixed.view('u1')).sandboxes;
    expect(s).toMatchObject({ state: 'failed' });
    expect(s!.problem).toMatch(/is there already/);
    expect([...rt.volumes]).toEqual(['hopper-playground-0123456789ab-home']);
    expect(rt.boxes.size).toBe(0);
  });

  it('destroy takes one or a selection, and only the user\'s own', async () => {
    const rt = createFakeContainerRuntime();
    const p = playground(rt);
    const mine = p.create('u1', { count: 3, agent: 'claude', size: {} }).started;
    const theirs = p.create('u2', { count: 1, agent: 'claude', size: {} }).started;
    await settled(p);
    await settled(p, 'u2');
    expect(await p.destroy('u1', [mine[0]!.id, theirs[0]!.id])).toEqual({ destroyed: 1, problems: [] });
    expect((await p.view('u1')).sandboxes.map((s) => s.id)).toEqual([mine[1]!.id, mine[2]!.id].sort((a, b) => (mine.find((m) => m.id === a)!.name < mine.find((m) => m.id === b)!.name ? -1 : 1)));
    expect((await p.view('u2')).sandboxes).toHaveLength(1);
    expect(rt.boxes.size).toBe(3);
    expect(rt.volumes.size).toBe(3);
  });

  it('a playground sandbox gets no join code: it runs idle, with no secret', async () => {
    const rt = createFakeContainerRuntime();
    const p = playground(rt);
    p.create('u1', { count: 1, agent: 'claude', size: { cpus: 2, memoryMb: 3072 } });
    await settled(p);
    const [box] = [...rt.boxes.values()];
    expect(box!.spec.env).toEqual({});
    expect(box!.spec.script).toBe(IDLE_SCRIPT);
    expect(box!.spec.check).toBeUndefined();
    expect(box!.spec.limits).toEqual({ cpus: 2, memoryMb: 3072 });
    expect(box!.spec.image).toBe('ghcr.io/henningfutrell/hopper:box-claude');
    expect(box!.spec.labels[PLAYGROUND_LABEL]).toBe('inst1');
  });

  it('the sweep never touches a box that is not the playground\'s', async () => {
    const rt = createFakeContainerRuntime();
    rt.put({ name: 'hopper', image: 'hopper', network: 'n', volume: 'hopper-home', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'node' });
    rt.put({ name: 'hopper-sandbox-claude', image: 'img', network: 'n', volume: 'hopper-sandbox-claude-home', env: {}, labels: { 'io.hopper.box': 'inst1' }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent' });
    rt.put({ name: 'hopper-playground-left', image: 'img', network: 'n', volume: 'hopper-playground-left-home', env: {}, labels: { [PLAYGROUND_LABEL]: 'inst1' }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent' });
    const p = playground(rt);
    await p.start();
    await p.stop();
    expect([...rt.boxes.keys()].sort()).toEqual(['hopper', 'hopper-sandbox-claude']);
  });
});
