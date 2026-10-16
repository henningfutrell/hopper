// Issue #708: the remote container runtime — an attached machine's own Podman or Docker, its calls carried over the
// machine's link by its client (src/sandbox/remote.ts, src/client/runtime.ts). The real client on a link; the
// machine's Podman a libpod double (test/support/fake-libpod.ts).
//
// Feature: the hopper drives a client target's own runtime through its client
//   Scenario: a box's whole life runs through the client: the same calls, the same sandbox flags
//   Scenario: a tools image is built on the machine through its client, once
//   Scenario: a check box runs on the machine through its client: its end awaited, its framed output read whole
//   Scenario: a need box runs on the machine through its client, and its leaked home is listed and burned there (issue #1371)
//   Scenario: a machine with no runtime, or one not dialled in, is a problem, not an error
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeRelay } from '../../src/executors/client.ts';
import { libpodCreateBody } from '../../src/sandbox/flags.ts';
import { NEED_LABEL, sweepHomes } from '../../src/sandbox/owned.ts';
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

/** A need box (issue #1007): what the hopper makes on a machine (issue #1349: no sandbox box joins as a machine). */
const spec = {
  name: 'hopper-need-kube-1', image: 'example.org/kube-box:1', network: 'host', volume: 'hopper-need-kube-1-home',
  env: {}, labels: { 'io.hopper.need': 'i-1', 'io.hopper.user': 'admin' },
  limits: { cpus: 2, memoryMb: 2048 }, user: 'agent', script: 'echo hi',
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
    expect((await rt.list({ 'io.hopper.need': 'i-1' })).map((x) => x.id)).toEqual([id]);
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

  it('a check box runs on the machine through its client: its end awaited, its framed output read whole', async () => {
    const libpod = createFakeLibpod();
    api = await startFakeRuntimeApi(libpod.handlers);
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api!.socket }) });
    const rt = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    const check = { ...spec, name: 'hopper-check-asked-1', volume: 'hopper-check-asked-1-home', labels: { 'io.hopper.check': 'i-1', 'io.hopper.user': 'admin' }, script: 'echo hi' };
    await rt.createVolume(check.volume, check.labels);
    const id = await rt.create(check);
    expect(libpod.containers.get(id)!.body).toEqual(libpodCreateBody(check));
    // Frames longer than 127 bytes, and text that is not ASCII: the length bytes and the text arrive as sent.
    const long = `${'é'.repeat(150)}\n`;
    libpod.containers.get(id)!.run = { exit: 1, logs: Buffer.concat([frame('HOPPER-PROBE 0 1 '), frame(long), frame('done')]) };
    await rt.start(id);
    expect(await rt.wait(id, 30 * 60_000)).toBe(1);
    expect(await rt.logs(id)).toBe(`HOPPER-PROBE 0 1 ${long}done`);
    await rt.remove(id);
    await rt.removeVolume(check.volume);
    expect(libpod.containers.size).toBe(0);
    expect(libpod.volumes.size).toBe(0);
  });

  it('a need box runs on the machine through its client, and its leaked home is listed and burned there (issue #1371)', async () => {
    const libpod = createFakeLibpod();
    api = await startFakeRuntimeApi(libpod.handlers);
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api!.socket }) });
    const rt = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    const need = { ...spec, name: 'hopper-need-infra-1a2b3c4d', volume: 'hopper-need-infra-1a2b3c4d-home', labels: { [NEED_LABEL]: 'i-1', 'io.hopper.user': 'admin' }, script: 'echo hi' };
    await rt.createVolume(need.volume, need.labels);
    const id = await rt.create(need);
    libpod.containers.get(id)!.run = { exit: 0, logs: frame('hi\n') };
    await rt.start(id);
    expect(await rt.wait(id, 60_000)).toBe(0);
    expect(await rt.logs(id)).toBe('hi\n');
    // The box goes, and its home stays (a remove that failed): the sweep lists it, and burns it.
    await rt.remove(id);
    await rt.createVolume('hopper-need-other-home', { [NEED_LABEL]: 'i-2' });
    await sweepHomes(rt, { [NEED_LABEL]: 'i-1' }, new Set());
    expect([...libpod.volumes]).toEqual(['hopper-need-other-home']);
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

const frame = (s: string): Buffer => { const b = Buffer.from(s); const h = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
