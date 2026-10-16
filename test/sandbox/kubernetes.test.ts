// Issue #1286 (part of #1281): sandbox boxes as pods, through the Kubernetes API, with no container socket. The API is
// an in-memory double at the runtime's seam (test/support/fake-kube-api.ts).
//
// Feature: the Kubernetes container runtime
//   Scenario: a box is a pod with the sandbox flags, made only after the egress policy
//   Scenario: the egress policy: no ingress; egress to DNS, the hopper on its port, and public addresses only
//   Scenario: a one-shot container runs its script and is not restarted
//   Scenario: a name Kubernetes does not take is made DNS-safe, and the runtime still answers the hopper's name
//   Scenario: the runtime sees only its own pods
//   Scenario: start waits until the pod runs, and says why it cannot
//   Scenario: wait answers the exit code, and gives up at its time limit
//   Scenario: files are copied in through tar
//   Scenario: the home is a claim; one that exists is kept
//   Scenario: listVolumes answers the runtime's own claims with every label asked, by the hopper's name (issue #1371)
//   Scenario: stop, remove and removeVolume refuse a pod or claim that is not the runtime's: the hopper's own pod, a
//     claim of the hopper's Postgres (issue #1371)
//   Scenario: a box gets no more CPU and memory than the most the chart gives (issue #1422)
//   Scenario: a box Kubernetes killed for its memory says so in its log (issue #1422)
//   Scenario: an API it cannot reach is its problem
//   Scenario: the image's user is the box image's agent user, by number, and nothing is built
//   Scenario: every pod gets the PriorityClass the runtime is given, for the sandbox quota (issue #1410)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import type { ContainerSpec } from '../../src/domain/sandboxes.ts';
import { createKubernetesRuntime, kubeName, POD_LABEL } from '../../src/sandbox/kubernetes.ts';
import { createFakeKubeApi, type FakeKubeApi } from '../support/fake-kube-api.ts';

const hopper = { namespace: 'hopper', labels: { 'app.kubernetes.io/name': 'hopper' }, port: 4790 };
const spec = (over: Partial<ContainerSpec> = {}): ContainerSpec => ({
  name: 'hopper-sandbox-infra', image: 'ghcr.io/henningfutrell/hopper:box-claude', network: 'hopper_default', volume: 'hopper-sandbox-infra-home',
  env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-infra' }, labels: { 'io.hopper.box': 'abc123', 'io.hopper.user': 'u1', 'io.hopper.sandbox': 's1' },
  limits: { cpus: 1.5, memoryMb: 2048 }, user: '1000:1000', ...over,
});
const runtime = (api: FakeKubeApi) => createKubernetesRuntime({ api, hopper, pollMs: 1, startMs: 50 });
const podOf = (api: FakeKubeApi, name: string): V1Pod => api.pods.get(name)!;

describe('the Kubernetes container runtime', () => {
  it('a box is a pod with the sandbox flags, made only after the egress policy', async () => {
    const api = createFakeKubeApi();
    const id = await runtime(api).create(spec());
    expect(id).toBe('hopper-sandbox-infra');
    expect(api.calls.filter((c) => !c.startsWith('readPod'))).toEqual(['applyNetworkPolicy hopper-sandbox', 'createPod hopper-sandbox-infra']);
    const pod = podOf(api, id);
    expect(pod.metadata?.labels).toMatchObject({ [POD_LABEL]: 'true', 'io.hopper.box': 'abc123', 'io.hopper.user': 'u1', 'io.hopper.sandbox': 's1' });
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false, enableServiceLinks: false, restartPolicy: 'Always', terminationGracePeriodSeconds: 10,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [{ name: 'home', persistentVolumeClaim: { claimName: 'hopper-sandbox-infra-home' } }, { name: 'tmp', emptyDir: {} }],
    });
    expect(pod.spec?.hostNetwork).toBeFalsy();
    const c = pod.spec!.containers[0]!;
    expect(c).toMatchObject({
      image: 'ghcr.io/henningfutrell/hopper:box-claude', env: [{ name: 'HOPPER_CLIENT_NAME', value: 'hopper-sandbox-infra' }],
      securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      resources: { limits: { cpu: '1.5', memory: '2048Mi' } },
      volumeMounts: [{ name: 'home', mountPath: '/home/agent' }, { name: 'tmp', mountPath: '/tmp' }],
    });
    expect(c.command).toBeUndefined();
  });

  it('refuses a user that is not a number, or root', async () => {
    const api = createFakeKubeApi();
    await expect(runtime(api).create(spec({ user: 'agent' }))).rejects.toThrow(/by number/);
    await expect(runtime(api).create(spec({ user: '0:0' }))).rejects.toThrow(/root/);
    expect(api.pods.size).toBe(0);
  });

  it('the egress policy: no ingress; egress to DNS, the hopper on its port, and public addresses only', async () => {
    const api = createFakeKubeApi();
    await runtime(api).create(spec());
    const policy = api.policies.get('hopper-sandbox') as { spec: Record<string, unknown> };
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { [POD_LABEL]: 'true' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        { to: [{ namespaceSelector: {} }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'hopper' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'hopper' } } }], ports: [{ protocol: 'TCP', port: 4790 }] },
        {
          to: [
            { ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'] } },
            { ipBlock: { cidr: '::/0', except: ['::1/128', 'fc00::/7', 'fe80::/10'] } },
          ],
        },
      ],
    });
  });

  it('a one-shot container runs its script and is not restarted', async () => {
    const api = createFakeKubeApi();
    const id = await runtime(api).create({ ...spec(), name: 'hopper-check-infra-1', volume: 'hopper-check-infra-1-home', script: 'echo hi' });
    const pod = podOf(api, id);
    expect(pod.spec?.restartPolicy).toBe('Never');
    expect(pod.spec!.containers[0]!.command).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('a name Kubernetes does not take is made DNS-safe, and the runtime still answers the hopper\'s name', async () => {
    expect(kubeName('hopper-sandbox-infra')).toBe('hopper-sandbox-infra');
    const odd = 'hopper-sandbox-my_template.v2';
    expect(kubeName(odd)).toMatch(/^hopper-sandbox-my-template-v2-[0-9a-f]{10}$/);
    expect(kubeName(`hopper-sandbox-${'a'.repeat(64)}`).length).toBeLessThanOrEqual(63);
    expect(kubeName(odd)).not.toBe(kubeName('hopper-sandbox-my-template-v2'));
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec({ name: odd, volume: `${odd}-home` }));
    expect(id).toBe(kubeName(odd));
    expect(podOf(api, id).spec!.volumes![0]!.persistentVolumeClaim!.claimName).toBe(kubeName(`${odd}-home`));
    expect((await rt.list()).map((x) => x.name)).toEqual([odd]);
    expect((await rt.inspect(id))?.name).toBe(odd);
    expect((await rt.inspect(odd))?.id).toBe(id);
  });

  it('a label value Kubernetes does not take is selected by its hash, and answered as given', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const user = 'user@example';
    await rt.create(spec({ labels: { 'io.hopper.box': 'abc123', 'io.hopper.user': user } }));
    const [listed] = await rt.list({ 'io.hopper.user': user });
    expect(listed?.labels['io.hopper.user']).toBe(user);
    expect(await rt.list({ 'io.hopper.user': 'someone-else' })).toEqual([]);
  });

  it('the runtime sees only its own pods', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    api.pods.set('hopper-0', { metadata: { name: 'hopper-0', labels: { 'app.kubernetes.io/name': 'hopper' } }, spec: { containers: [{ name: 'hopper', image: 'x' }] }, status: { phase: 'Running' } });
    await rt.create(spec());
    expect((await rt.list()).map((x) => x.id)).toEqual(['hopper-sandbox-infra']);
    expect(await rt.inspect('hopper-0')).toBeUndefined();
    expect(api.calls).toContain(`listPods ${POD_LABEL}=true`);
  });

  it('start waits until the pod runs', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec());
    setTimeout(() => api.phase(id, 'Running'), 5);
    await rt.start(id);
    expect((await rt.inspect(id))?.state).toBe('running');
  });

  it('start says why the pod cannot start', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec());
    api.phase(id, 'Pending', { waiting: 'ImagePullBackOff' });
    await expect(rt.start(id)).rejects.toThrow(/ImagePullBackOff/);
    api.phase(id, 'Pending');
    await expect(rt.start(id)).rejects.toThrow(/did not start/);
  });

  it('wait answers the exit code, and gives up at its time limit', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec({ script: 'exit 3' }));
    api.phase(id, 'Running');
    await expect(rt.wait(id, 20)).rejects.toThrow(/did not end/);
    setTimeout(() => api.phase(id, 'Failed', { exitCode: 3 }), 5);
    expect(await rt.wait(id, 5_000)).toBe(3);
    expect((await rt.inspect(id))?.state).toBe('exited');
    api.logs.set(id, 'PROBE ok\n');
    expect(await rt.logs(id)).toBe('PROBE ok\n');
  });

  it('files are copied in through tar, as the box\'s user', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec());
    const tar = join(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'kube-')), 'in.tar');
    writeFileSync(tar, 'TAR');
    await rt.copyIn!(id, '/home/agent/work', tar);
    expect(api.execs.at(-1)).toEqual({ pod: id, cmd: ['tar', '-x', '-m', '--no-overwrite-dir', '-f', '-', '-C', '/home/agent/work'], stdin: 'TAR' });
    api.onExec = () => ({ exit: 2, stderr: 'tar: cannot open' });
    await expect(rt.copyIn!(id, '/home/agent', tar)).rejects.toThrow(/tar: cannot open/);
  });

  it('stop and remove take the pod; one already gone is no error', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec());
    await rt.stop(id);
    await rt.remove(id);
    expect(api.pods.size).toBe(0);
  });

  it('the home is a claim; one that exists is kept', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    expect(await rt.createVolume('hopper-sandbox-infra-home', { 'io.hopper.box': 'abc123' })).toBe(true);
    expect(await rt.createVolume('hopper-sandbox-infra-home', { 'io.hopper.box': 'abc123' })).toBe(false);
    expect(api.claims.get('hopper-sandbox-infra-home')).toMatchObject({
      metadata: { name: 'hopper-sandbox-infra-home', labels: { 'io.hopper.box': 'abc123' } },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '5Gi' } } },
    });
    await rt.removeVolume('hopper-sandbox-infra-home');
    expect(api.claims.size).toBe(0);
  });

  it('listVolumes answers the runtime\'s own claims with every label asked, by the hopper\'s name (issue #1371)', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    await rt.createVolume('hopper_need.x-home', { 'io.hopper.need': 'i-1' });
    await rt.createVolume('hopper-check-y-home', { 'io.hopper.check': 'i-1' });
    api.claims.set('data-hopper-postgres-0', { metadata: { name: 'data-hopper-postgres-0', labels: { 'io.hopper.need': 'i-1' } } });
    expect(await rt.listVolumes({ 'io.hopper.need': 'i-1' })).toEqual(['hopper_need.x-home']);
    await rt.removeVolume('hopper_need.x-home');
    expect([...api.claims.keys()]).toEqual(['hopper-check-y-home', 'data-hopper-postgres-0']);
  });

  it('stop, remove and removeVolume refuse a pod or claim that is not the runtime\'s: the hopper\'s own pod, a claim of its Postgres (issue #1371)', async () => {
    const api = createFakeKubeApi();
    api.pods.set('hopper-0', { metadata: { name: 'hopper-0', labels: { 'app.kubernetes.io/name': 'hopper' } }, spec: { containers: [] }, status: { phase: 'Running' } });
    api.claims.set('data-hopper-postgres-0', { metadata: { name: 'data-hopper-postgres-0', labels: { 'app.kubernetes.io/name': 'postgres' } } });
    const rt = runtime(api);
    await expect(rt.stop('hopper-0')).rejects.toThrow('the hopper leaves the pod hopper-0: it carries no sandbox label');
    await expect(rt.remove('hopper-0')).rejects.toThrow('the hopper leaves the pod hopper-0: it carries no sandbox label');
    await expect(rt.removeVolume('data-hopper-postgres-0')).rejects.toThrow('the hopper leaves the claim data-hopper-postgres-0: it carries no sandbox label');
    expect(api.pods.has('hopper-0')).toBe(true);
    expect(api.claims.has('data-hopper-postgres-0')).toBe(true);
    expect(api.calls.filter((c) => c.startsWith('delete'))).toEqual([]);
  });

  it('a box gets no more CPU and memory than the most the chart gives, and what it asks under that (issue #1422)', async () => {
    const api = createFakeKubeApi();
    const rt = createKubernetesRuntime({ api, hopper, pollMs: 1, startMs: 50, most: { cpus: 0.5, memoryMb: 1024 } });
    const big = await rt.create(spec());
    expect(podOf(api, big).spec!.containers[0]!.resources).toEqual({ limits: { cpu: '0.5', memory: '1024Mi' } });
    const small = await rt.create(spec({ name: 'small', volume: 'small-home', limits: { cpus: 0.25, memoryMb: 256 } }));
    expect(podOf(api, small).spec!.containers[0]!.resources).toEqual({ limits: { cpu: '0.25', memory: '256Mi' } });
    // Only memory given: the CPU is the box's own.
    const memory = createKubernetesRuntime({ api, hopper, most: { memoryMb: 512 } });
    const m = await memory.create(spec({ name: 'memory', volume: 'memory-home' }));
    expect(podOf(api, m).spec!.containers[0]!.resources).toEqual({ limits: { cpu: '1.5', memory: '512Mi' } });
  });

  it('a box Kubernetes killed for its memory says so in its log; another box\'s log is as it is (issue #1422)', async () => {
    const api = createFakeKubeApi();
    const rt = runtime(api);
    const id = await rt.create(spec({ script: 'eat memory' }));
    api.logs.set(id, 'allocating');
    api.phase(id, 'Failed', { exitCode: 137, reason: 'OOMKilled' });
    expect(await rt.wait(id, 5_000)).toBe(137);
    expect(await rt.logs(id)).toBe('allocating\nhopper: Kubernetes killed the box: it went over its memory limit (2048Mi, OOMKilled)\n');
    const other = await rt.create(spec({ name: 'other', volume: 'other-home', script: 'exit 137' }));
    api.logs.set(other, 'killed\n');
    api.phase(other, 'Failed', { exitCode: 137 });
    expect(await rt.logs(other)).toBe('killed\n');
  });

  it('an API it cannot reach is its problem', async () => {
    const api = createFakeKubeApi();
    expect(await runtime(api).problem()).toBeUndefined();
    api.refuse = new Error('connect ECONNREFUSED');
    expect(await runtime(api).problem()).toMatch(/cannot reach the Kubernetes API in the namespace hopper: connect ECONNREFUSED/);
  });

  it('the image\'s user is the box image\'s agent user, by number, and nothing is built', async () => {
    const rt = runtime(createFakeKubeApi());
    expect(rt.kind).toBe('kubernetes');
    expect(await rt.pull('ghcr.io/henningfutrell/hopper:box-claude')).toEqual({ user: '1000:1000' });
    expect(rt.build).toBeUndefined();
  });

  it('every pod gets the PriorityClass the runtime is given, for the sandbox quota (issue #1410)', async () => {
    const api = createFakeKubeApi();
    await createKubernetesRuntime({ api, hopper, priorityClass: 'hopper-sandbox', pollMs: 1, startMs: 50 }).create(spec());
    expect(podOf(api, 'hopper-sandbox-infra').spec?.priorityClassName).toBe('hopper-sandbox');
    await runtime(api).create(spec({ name: 'other' }));
    expect(podOf(api, 'other').spec?.priorityClassName).toBeUndefined();
  });
});
