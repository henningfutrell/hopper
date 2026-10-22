// Issue #708: the Podman container runtime against a libpod API double (test/support/fake-runtime-api.ts): the request
// shapes of every call, the sandbox flags, the resource limits and the labels in the create body.
//
// Feature: the hopper drives rootless Podman through its own API
//   Scenario: create sends the sandbox flags, the limits, the labels, the user and the home volume
//   Scenario: pull pulls only a missing image, and answers the user the image runs as
//   Scenario: a pull whose stream carries an error fails with it
//   Scenario: build sends the Containerfile in a tar, only when the image is not there yet (issue #716)
//   Scenario: a build whose stream carries an error fails with it
//   Scenario: inspect, list, start, stop and remove use the container id; gone is no error
//   Scenario: volumes are made and removed by name; one that exists or is gone is no error
//   Scenario: listVolumes answers the volumes with every label asked, by name, through a machine's relay too (issue #1371)
//   Scenario: stop, remove and removeVolume refuse what carries no sandbox label: a hopper stack container, a volume of
//     someone else's (issue #1371)
//   Scenario: a rootful Podman is a problem; a reachable rootless one is none
//   Scenario: a one-shot container runs its script on a terminal, never restarted; wait answers its exit code, logs its
//     output with the frames taken off (issue #716)
import { afterEach, describe, expect, it } from 'vitest';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const API = '/v5.0.0/libpod';
let api: FakeRuntimeApi | undefined;
afterEach(async () => { await api?.close(); api = undefined; });

const spec = {
  name: 'hopper-sandbox-kube', image: 'example.org/kube-box:1', network: 'hopper_default', volume: 'hopper-sandbox-kube-home',
  env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-kube' }, labels: { 'io.hopper.box': 'i-1', 'io.hopper.user': 'admin' },
  limits: { cpus: 1.5, memoryMb: 2048 }, user: 'agent',
};

describe('the Podman container runtime', () => {
  it('create sends the sandbox flags, the limits, the labels, the user and the home volume', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'c0ffee', Warnings: [] } })]);
    const id = await createPodmanRuntime(api.socket).create(spec);
    expect(id).toBe('c0ffee');
    expect(api.seen[0]!.body).toEqual({
      name: spec.name, image: spec.image, labels: spec.labels, env: spec.env, user: 'agent',
      cap_drop: ['ALL'], no_new_privileges: true, read_only_filesystem: true, read_only_tmpfs: false,
      mounts: [{ destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['rw', 'nosuid', 'nodev'] }],
      volumes: [{ Name: spec.volume, Dest: '/home/agent' }],
      resource_limits: { cpu: { quota: 150_000, period: 100_000 }, memory: { limit: 2048 * 1024 * 1024 } },
      restart_policy: 'unless-stopped',
      netns: { nsmode: 'bridge' }, networks: { hopper_default: {} },
    });
  });

  it('on the host network, create joins the host namespace', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'c1' } })]);
    await createPodmanRuntime(api.socket).create({ ...spec, network: 'host' });
    expect(api.seen[0]!.body).toMatchObject({ netns: { nsmode: 'host' } });
    expect(api.seen[0]!.body).not.toHaveProperty('networks');
  });

  it('on no network (a container target\'s command box, issue #865), create joins no network namespace', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'c2' } })]);
    await createPodmanRuntime(api.socket).create({ ...spec, network: 'none' });
    expect(api.seen[0]!.body).toMatchObject({ netns: { nsmode: 'none' } });
    expect(api.seen[0]!.body).not.toHaveProperty('networks');
  });

  it('a refused create fails with Podman\'s own words', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 500, body: { message: 'name is in use' } })]);
    await expect(createPodmanRuntime(api.socket).create(spec)).rejects.toThrow('podman refused to create the box hopper-sandbox-kube (500): name is in use');
  });

  it('pull pulls only a missing image, and answers the user the image runs as', async () => {
    const image = encodeURIComponent(spec.image);
    let present = false;
    api = await startFakeRuntimeApi([
      on('GET', `${API}/images/${image}/exists`, () => ({ status: present ? 204 : 404 })),
      on('POST', `${API}/images/pull`, () => { present = true; return { status: 200, text: '{"stream":"pulling"}\n{"id":"abc"}\n' }; }),
      on('GET', `${API}/images/${image}/json`, { status: 200, body: { Config: { User: 'agent' } } }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    expect(await rt.pull(spec.image)).toEqual({ user: 'agent' });
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${API}/images/${image}/exists`, `POST ${API}/images/pull`, `GET ${API}/images/${image}/json`,
    ]);
    expect(api.seen[1]!.query.get('reference')).toBe(spec.image);
    api.seen.length = 0;
    expect(await rt.pull(spec.image)).toEqual({ user: 'agent' });
    expect(api.seen.map((r) => r.method)).toEqual(['GET', 'GET']);
  });

  it('an image that sets no user answers the empty user', async () => {
    const image = encodeURIComponent(spec.image);
    api = await startFakeRuntimeApi([
      on('GET', `${API}/images/${image}/exists`, { status: 204 }),
      on('GET', `${API}/images/${image}/json`, { status: 200, body: { Config: {} } }),
    ]);
    expect(await createPodmanRuntime(api.socket).pull(spec.image)).toEqual({ user: '' });
  });

  it('a pull whose stream carries an error fails with it', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${API}/images/pull`, { status: 200, text: '{"error":"no such host"}\n' }),
    ]);
    await expect(createPodmanRuntime(api.socket).pull(spec.image)).rejects.toThrow(`podman could not pull ${spec.image}: no such host`);
  });

  it('inspect, list, start, stop and remove use the container id; gone is no error', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/c0ffee/json`, { status: 200, body: { Id: 'c0ffee', Name: spec.name, ImageName: spec.image, Config: { Labels: spec.labels }, State: { Status: 'running' } } }),
      on('GET', `${API}/containers/json`, { status: 200, body: [{ Id: 'c0ffee', Names: [spec.name], Image: spec.image, Labels: spec.labels, State: 'running' }] }),
      on('POST', `${API}/containers/c0ffee/start`, { status: 204 }),
      on('POST', `${API}/containers/c0ffee/stop`, { status: 304 }),
      on('DELETE', `${API}/containers/c0ffee`, { status: 200, body: [] }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    expect(await rt.inspect('c0ffee')).toEqual({ id: 'c0ffee', name: spec.name, image: spec.image, labels: spec.labels, state: 'running' });
    expect(await rt.inspect('gone')).toBeUndefined();
    expect(await rt.list({ 'io.hopper.box': 'i-1' })).toEqual([{ id: 'c0ffee', name: spec.name, image: spec.image, labels: spec.labels, state: 'running' }]);
    const listed = api.seen.find((r) => r.path === `${API}/containers/json`)!;
    expect(listed.query.get('all')).toBe('true');
    expect(JSON.parse(listed.query.get('filters')!)).toEqual({ label: ['io.hopper.box=i-1'] });
    await rt.start('c0ffee');
    await rt.stop('c0ffee');
    await rt.stop('gone');
    await rt.remove('c0ffee');
    await rt.remove('gone');
    const removed = api.seen.find((r) => r.method === 'DELETE' && r.path === `${API}/containers/c0ffee`)!;
    // Its volumes stay: the home volume is the sandbox module's to keep or remove.
    expect(removed.query.get('force')).toBe('true');
    expect(removed.query.get('v')).toBeNull();
    expect(api.seen.find((r) => r.path === `${API}/containers/c0ffee/stop`)!.query.get('timeout')).toBe('10');
  });

  it('stop, remove and removeVolume refuse what carries no sandbox label: a hopper stack container, a volume of someone else\'s (issue #1371)', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/stack/json`, { status: 200, body: { Id: 'stack', Name: 'hopper_hopper_1', Config: { Labels: { 'com.docker.compose.project': 'hopper' } }, State: { Status: 'running' } } }),
      on('GET', `${API}/volumes/hopper_pgdata/json`, { status: 200, body: { Name: 'hopper_pgdata', Labels: { 'com.docker.compose.project': 'hopper' } } }),
      on('GET', `${API}/volumes/bare/json`, { status: 200, body: { Name: 'bare', Labels: null } }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    await expect(rt.stop('stack')).rejects.toThrow('the hopper leaves the box stack: it carries no sandbox label');
    await expect(rt.remove('stack')).rejects.toThrow('the hopper leaves the box stack: it carries no sandbox label');
    await expect(rt.removeVolume('hopper_pgdata')).rejects.toThrow('the hopper leaves the volume hopper_pgdata: it carries no sandbox label');
    await expect(rt.removeVolume('bare')).rejects.toThrow('the hopper leaves the volume bare: it carries no sandbox label');
    expect(api.seen.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('volumes are made and removed by name; one that exists or is gone is no error', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${API}/volumes/create`, (r) => ({ status: (r.body as { Name: string }).Name === 'taken' ? 409 : 201, body: {} })),
      on('GET', `${API}/volumes/home/json`, { status: 200, body: { Name: 'home', Labels: { 'io.hopper.box': 'i-1' } } }),
      on('DELETE', `${API}/volumes/home`, { status: 204 }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    await rt.createVolume('home', { 'io.hopper.box': 'i-1' });
    await rt.createVolume('taken', {});
    await rt.removeVolume('home');
    await rt.removeVolume('gone');
    expect(api.seen[0]!.body).toEqual({ Name: 'home', Label: { 'io.hopper.box': 'i-1' } });
    expect(api.seen.find((r) => r.method === 'DELETE')!.query.get('force')).toBe('true');
  });

  it('listVolumes answers the volumes with every label asked, by name, through a machine\'s relay too (issue #1371)', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/volumes/json`, { status: 200, body: [{ Name: 'hopper-need-a-home', Labels: { 'io.hopper.need': 'i-1' } }] }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    expect(await rt.listVolumes({ 'io.hopper.need': 'i-1' })).toEqual(['hopper-need-a-home']);
    expect(JSON.parse(api.seen[0]!.query.get('filters')!)).toEqual({ label: ['io.hopper.need=i-1'] });
    expect(await createPodmanRuntime('studio', async () => ({ status: 200, text: '[{"Name":"hopper-need-b-home"}]' })).listVolumes({ 'io.hopper.need': 'i-1' })).toEqual(['hopper-need-b-home']);
  });

  it('build sends the Containerfile in a tar, only when the image is not there yet (issue #716)', async () => {
    const tag = 'localhost/hopper-box-tools:0123456789abcdef';
    let present = false;
    api = await startFakeRuntimeApi([
      on('GET', `${API}/images/${encodeURIComponent(tag)}/exists`, () => ({ status: present ? 204 : 404 })),
      on('POST', `${API}/build`, () => { present = true; return { status: 200, text: '{"stream":"STEP 1/4"}\n{"stream":"COMMIT"}\n' }; }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    await rt.build(tag, 'FROM example.org/kube-box:1\n');
    const build = api.seen.find((r) => r.path === `${API}/build`)!;
    expect(build.query.get('t')).toBe(tag);
    expect(build.query.get('dockerfile')).toBe('Containerfile');
    expect(String(build.body)).toContain('Containerfile');
    expect(String(build.body)).toContain('FROM example.org/kube-box:1\n');
    api.seen.length = 0;
    await rt.build(tag, 'FROM example.org/kube-box:1\n');
    expect(api.seen.map((r) => r.method)).toEqual(['GET']);
  });

  it('a build whose stream carries an error fails with it', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${API}/build`, { status: 200, text: '{"stream":"STEP 2/4"}\n{"error":"sha256sum: WARNING: 1 computed checksum did NOT match"}\n' }),
    ]);
    await expect(createPodmanRuntime(api.socket).build('localhost/x:1', 'FROM x\n')).rejects.toThrow('podman could not build localhost/x:1: sha256sum: WARNING: 1 computed checksum did NOT match');
  });

  it('a one-shot container runs its script on a terminal, never restarted, its log in a file; wait answers its exit code, logs its output (issues #716, #2406)', async () => {
    // libpod frames its logs even on a terminal: a stream byte, three zeros, a four-byte length, the bytes.
    const frame = (s: string): string => `\u0001\u0000\u0000\u0000${String.fromCharCode(0, 0, 0, s.length)}${s}`;
    api = await startFakeRuntimeApi([
      on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'c1' } }),
      on('POST', `${API}/containers/c1/wait`, { status: 200, text: '3\n' }),
      on('GET', `${API}/containers/c1/logs`, { status: 200, text: frame('HOPPER-PROBE 0 1 ') + frame('aGkK\r\n') }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    await rt.create({ ...spec, script: 'echo hi' });
    expect(api.seen[0]!.body).toMatchObject({ entrypoint: ['/bin/sh'], command: ['-c', 'echo hi'], terminal: true, restart_policy: 'no', cap_drop: ['ALL'], read_only_filesystem: true });
    // Its log in a file, not journald, which drops a large output (issue #2406).
    expect(api.seen[0]!.body).toMatchObject({ log_configuration: { driver: 'k8s-file' } });
    expect(await rt.wait('c1', 5000)).toBe(3);
    expect(api.seen[1]!.query.getAll('condition')).toEqual(['exited', 'stopped']);
    expect(await rt.logs('c1')).toBe('HOPPER-PROBE 0 1 aGkK\r\n');
    expect(api.seen[2]!.query.get('stdout')).toBe('true');
    expect(api.seen[2]!.query.get('stderr')).toBe('true');
  });

  it('a rootful Podman is a problem; a reachable rootless one is none', async () => {
    let rootless = false;
    api = await startFakeRuntimeApi([on('GET', `${API}/info`, () => ({ status: 200, body: { host: { security: { rootless } } } }))]);
    const rt = createPodmanRuntime(api.socket);
    expect(rt.kind).toBe('podman');
    expect(await rt.problem()).toMatch(/is not rootless/);
    rootless = true;
    expect(await rt.problem()).toBeUndefined();
  });

  it('a socket nothing listens on is a problem that names the socket', async () => {
    expect(await createPodmanRuntime('/nonexistent/podman.sock').problem()).toMatch(/^cannot reach podman at \/nonexistent\/podman\.sock: /);
  });
});
