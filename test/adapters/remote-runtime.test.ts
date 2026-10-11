// Issue #708: the remote container runtime — an attached machine's own Podman or Docker, its calls carried over the
// machine's link by its client (src/sandbox/remote.ts, src/client/runtime.ts). The real client on a link; the
// machine's Podman a libpod double (test/support/fake-libpod.ts).
//
// Feature: the hopper drives a client target's own runtime through its client
//   Scenario: a box's whole life runs through the client: the same calls, the same sandbox flags
//   Scenario: a tools image is built on the machine through its client, once
//   Scenario: a machine with no runtime, or one not dialled in, is a problem, not an error
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeRelay } from '../../src/executors/client.ts';
import { libpodCreateBody } from '../../src/sandbox/flags.ts';
import { createRemoteRuntime } from '../../src/sandbox/remote.ts';
import { toolsImage } from '../../src/sandbox/tools.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const TOKEN = 'b'.repeat(43);
let c: TestClient | undefined;
let api: FakeRuntimeApi | undefined;
afterEach(async () => {
  await c?.stop();
  c = undefined;
  await api?.close();
  api = undefined;
});

const spec = {
  name: 'hopper-sandbox-kube', image: 'example.org/kube-box:1', network: 'host', volume: 'hopper-sandbox-kube-home',
  env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-kube' }, labels: { 'io.hopper.box': 'i-1', 'io.hopper.user': 'admin', 'io.hopper.sandbox': 's-1' },
  limits: { cpus: 2, memoryMb: 2048 }, user: 'agent',
};

describe('the remote container runtime', () => {
  it('a box\'s whole life runs through the client: the same calls, the same sandbox flags', async () => {
    const libpod = createFakeLibpod();
    api = await startFakeRuntimeApi(libpod.handlers);
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api!.socket }) });
    const rt = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    expect(rt.kind).toBe('remote');
    expect(await rt.problem()).toBeUndefined();

    expect(await rt.pull(spec.image)).toEqual({ user: 'agent' });
    expect(libpod.images.has(spec.image)).toBe(true);
    expect(await rt.createVolume(spec.volume, spec.labels)).toBe(true);
    expect(await rt.createVolume(spec.volume, spec.labels)).toBe(false);
    const id = await rt.create(spec);
    expect(libpod.containers.get(id)!.body).toEqual(libpodCreateBody(spec));
    await rt.start(id);
    expect(await rt.inspect(id)).toEqual({ id, name: spec.name, image: spec.image, labels: spec.labels, state: 'running' });
    expect((await rt.list({ 'io.hopper.sandbox': 's-1' })).map((x) => x.id)).toEqual([id]);
    await rt.stop(id);
    await rt.remove(id);
    await rt.remove(id);
    expect(await rt.inspect(id)).toBeUndefined();
    await rt.removeVolume(spec.volume);
    expect(libpod.volumes.size).toBe(0);
  });

  it('a tools image is built on the machine through its client, once', async () => {
    const libpod = createFakeLibpod();
    api = await startFakeRuntimeApi(libpod.handlers);
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api!.socket }) });
    const rt = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    const built = toolsImage({ image: spec.image, id: 'sha256:base' }, ['kubectl']);
    await rt.build(built.tag, built.containerfile);
    expect(libpod.builds.get(built.tag)).toBe(built.containerfile);
    expect(await rt.pull(built.tag)).toEqual({ user: 'agent' });
    const builds = api.seen.filter((s) => s.path.endsWith('/build')).length;
    await rt.build(built.tag, built.containerfile);
    expect(api.seen.filter((s) => s.path.endsWith('/build')).length).toBe(builds);
  });

  it('a machine with no runtime, or one not dialled in, is a problem, not an error', async () => {
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({}) });
    const none = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    expect(await none.problem()).toMatch(/^studio: no Podman or Docker socket/);
    await expect(none.list()).rejects.toThrow(/no Podman or Docker socket/);

    const away = createRemoteRuntime('laptop', runtimeRelay({ machine: 'laptop', link: () => undefined, token: () => TOKEN }));
    expect(await away.problem()).toMatch(/client laptop is not dialled in/);
  });
});
