// Issue #708: the Podman container runtime against a libpod API double (test/support/fake-runtime-api.ts): the request
// shapes of every call, the sandbox flags, the resource limits and the labels in the create body. The same adapter
// against real rootless Podman is test/adapters/podman-sandbox.test.ts.
//
// Feature: the hopper drives rootless Podman through its own API
//   Scenario: create sends the sandbox flags, the limits, the labels, the user and the home volume
//   Scenario: pull pulls only a missing image, and answers the user the image runs as
//   Scenario: a pull whose stream carries an error fails with it
//   Scenario: build sends the Containerfile in a tar, only when the image is not there yet (issue #716)
//   Scenario: a build whose stream carries an error fails with it
//   Scenario: inspect, list, start, stop and remove use the container id; gone is no error
//   Scenario: volumes are made and removed by name; one that exists or is gone is no error
//   Scenario: a rootful Podman is a problem; a reachable rootless one is none
//   Scenario: a box's start check is its health check: bash with no profile and no rc fetches the hopper, run only when
//     the hopper asks (issue #708)
//   Scenario: startCheck runs the check now and answers what it wrote; a box with none answers nothing
//   Scenario: inspect answers the names a container has on each network
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

  it('a one-shot container runs its script on a terminal, never restarted; wait answers its exit code, logs its output (issue #716)', async () => {
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
    expect(await rt.wait('c1', 5000)).toBe(3);
    expect(api.seen[1]!.query.getAll('condition')).toEqual(['exited', 'stopped']);
    expect(await rt.logs('c1')).toBe('HOPPER-PROBE 0 1 aGkK\r\n');
    expect(api.seen[2]!.query.get('stdout')).toBe('true');
    expect(api.seen[2]!.query.get('stderr')).toBe('true');
  });

  it('a box\'s start check is its health check: bash with no profile and no rc fetches the hopper, run only when the hopper asks (issue #708)', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'c1' } })]);
    await createPodmanRuntime(api.socket).create({ ...spec, check: 'http://hopper:4790' });
    expect((api.seen[0]!.body as { healthconfig: unknown }).healthconfig).toEqual({
      Test: ['CMD', 'bash', '--noprofile', '--norc', '-c', "curl -fsS -m 5 -o /dev/null 'http://hopper:4790/client/install'"],
      // No interval: no timer on the computer runs it (a WSL or a computer with no user systemd has none).
      Interval: 0, Timeout: 10_000_000_000, Retries: 1,
    });
  });

  it('startCheck runs the check now and answers what it wrote; a box with none answers nothing', async () => {
    let status = 'unhealthy';
    const log = (): unknown[] => [{ ExitCode: status === 'healthy' ? 0 : 7, Output: status === 'healthy' ? '' : "curl: (7) Failed to connect to hopper port 4790: Couldn't connect to server\n" }];
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/c1/json`, () => ({ status: 200, body: { Id: 'c1', Config: { Healthcheck: { Test: ['CMD', 'true'] } }, State: { Status: 'running', Health: { Status: status, Log: log() } } } })),
      on('GET', `${API}/containers/c1/healthcheck`, () => ({ status: 200, body: { Status: status, FailingStreak: 1, Log: null } })),
      on('GET', `${API}/containers/old/json`, { status: 200, body: { Id: 'old', Config: {}, State: { Status: 'running' } } }),
      on('GET', `${API}/containers/stopped/json`, { status: 200, body: { Id: 'stopped', Config: { Healthcheck: { Test: ['CMD', 'true'] } }, State: { Status: 'exited' } } }),
    ]);
    const rt = createPodmanRuntime(api.socket);
    expect(await rt.startCheck('c1')).toEqual({ passed: false, output: "curl: (7) Failed to connect to hopper port 4790: Couldn't connect to server" });
    expect(api.seen.some((r) => r.path === `${API}/containers/c1/healthcheck`)).toBe(true);
    status = 'healthy';
    expect(await rt.startCheck('c1')).toEqual({ passed: true, output: '' });
    expect(await rt.startCheck('old')).toBeUndefined();
    expect(await rt.startCheck('stopped')).toEqual({ passed: false, output: 'the box is exited, not running' });
    expect(await rt.startCheck('gone')).toEqual({ passed: false, output: 'the box is gone' });
  });

  it('inspect answers the names a container has on each network', async () => {
    api = await startFakeRuntimeApi([on('GET', `${API}/containers/self/json`, { status: 200, body: {
      Id: 'abc', Name: 'hopper-hopper-1', ImageName: 'img', Config: { Labels: {} }, State: { Status: 'running' },
      NetworkSettings: { Networks: { hopper_default: { Aliases: ['hopper', 'abc'], IPAddress: '10.89.0.2' } } },
    } })]);
    expect((await createPodmanRuntime(api.socket).inspect('self'))?.networks).toEqual({ hopper_default: ['hopper', 'abc'] });
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
