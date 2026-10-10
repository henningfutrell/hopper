// Issue #708: the Podman container runtime against a libpod API double (test/support/fake-runtime-api.ts): the request
// shapes of every call, the sandbox flags, the resource limits and the labels in the create body. The same adapter
// against real rootless Podman is test/adapters/podman-sandbox.test.ts.
//
// Feature: the hopper drives rootless Podman through its own API
//   Scenario: create sends the sandbox flags, the limits, the labels, the user and the home volume
//   Scenario: pull pulls only a missing image, and answers the user the image runs as
//   Scenario: a pull whose stream carries an error fails with it
//   Scenario: inspect, list, start, stop and remove use the container id; gone is no error
//   Scenario: volumes are made and removed by name; one that exists or is gone is no error
//   Scenario: a rootful Podman is a problem; a reachable rootless one is none
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

  it('volumes are made and removed by name; one that exists or is gone is no error', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${API}/volumes/create`, (r) => ({ status: (r.body as { Name: string }).Name === 'taken' ? 409 : 201, body: {} })),
      on('DELETE', `${API}/volumes/home`, { status: 204 }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    await rt.createVolume('home', { 'io.hopper.box': 'i-1' });
    await rt.createVolume('taken', {});
    await rt.removeVolume('home');
    await rt.removeVolume('gone');
    expect(api.seen[0]!.body).toEqual({ Name: 'home', Label: { 'io.hopper.box': 'i-1' } });
    expect(api.seen[2]!.query.get('force')).toBe('true');
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
