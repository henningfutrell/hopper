// Issue #708: the Docker container runtime against a Docker Engine API double (test/support/fake-runtime-api.ts): the
// Engine API over its socket, never the docker CLI. The request shapes, the sandbox flags, the limits and the labels.
//
// Feature: the hopper drives Docker through the Docker Engine API
//   Scenario: create sends the sandbox flags, the limits, the labels, the user and the home volume, by name
//   Scenario: pull pulls only a missing image, and answers the user the image runs as
//   Scenario: build sends the Containerfile in a tar, only when the image is not there yet; a stream error fails it (issue #716)
//   Scenario: inspect and list read Docker's names without the leading slash
//   Scenario: listVolumes answers the volumes with every label asked, by name, through a machine's relay too (issue #1371)
//   Scenario: stop, remove and volumes: gone is no error, and removing keeps the volumes
//   Scenario: stop, remove and removeVolume refuse what carries no sandbox label (issue #1371)
//   Scenario: a rootful Docker is a problem: the hopper starts sandboxes only through a rootless runtime
import { afterEach, describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../../src/sandbox/docker.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const API = '/v1.41';
let api: FakeRuntimeApi | undefined;
afterEach(async () => { await api?.close(); api = undefined; });

const spec = {
  name: 'hopper-sandbox-claude', image: 'ghcr.io/henningfutrell/hopper:box-claude', network: 'hopper_default', volume: 'hopper-sandbox-claude-home',
  env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-claude' }, labels: { 'io.hopper.box': 'i-1' }, limits: { cpus: 2, memoryMb: 4096 }, user: 'agent',
};

describe('the Docker container runtime', () => {
  it('create sends the sandbox flags, the limits, the labels, the user and the home volume, by name', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'd0cker' } })]);
    expect(await createDockerRuntime(api.socket).create(spec)).toBe('d0cker');
    expect(api.seen[0]!.query.get('name')).toBe(spec.name);
    expect(api.seen[0]!.body).toEqual({
      Image: spec.image, Labels: spec.labels, User: 'agent', Env: ['HOPPER_CLIENT_NAME=hopper-sandbox-claude'],
      HostConfig: {
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid,nodev' },
        Mounts: [{ Type: 'volume', Source: spec.volume, Target: '/home/agent' }],
        NanoCpus: 2_000_000_000, Memory: 4096 * 1024 * 1024, RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'hopper_default',
      },
    });
  });

  it('a one-shot container runs its script on a TTY, never restarted, its log in a file (issue #2406); wait answers its exit code, logs its raw output (issue #716)', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${API}/containers/create`, { status: 201, body: { Id: 'd1' } }),
      on('POST', `${API}/containers/d1/wait`, { status: 200, body: { StatusCode: 0 } }),
      on('GET', `${API}/containers/d1/logs`, { status: 200, text: 'HOPPER-PROBE 0 0 aGkK\r\n' }),
    ]);
    const rt = createDockerRuntime(api.socket);
    await rt.create({ ...spec, script: 'echo hi' });
    expect(api.seen[0]!.body).toMatchObject({ Entrypoint: ['/bin/sh'], Cmd: ['-c', 'echo hi'], Tty: true, HostConfig: { RestartPolicy: { Name: 'no' }, CapDrop: ['ALL'], ReadonlyRootfs: true, LogConfig: { Type: 'json-file' } } });
    expect(await rt.wait('d1', 5000)).toBe(0);
    expect(await rt.logs('d1')).toBe('HOPPER-PROBE 0 0 aGkK\r\n');
  });

  it('pull pulls only a missing image, and answers the user the image runs as', async () => {
    const image = encodeURIComponent(spec.image);
    let present = false;
    api = await startFakeRuntimeApi([
      on('GET', `${API}/images/${image}/json`, () => (present ? { status: 200, body: { Config: { User: 'agent' } } } : { status: 404, body: { message: 'no such image' } })),
      on('POST', `${API}/images/create`, () => { present = true; return { status: 200, text: '{"status":"Pulling"}\n' }; }),
    ]);
    expect(await createDockerRuntime(api.socket).pull(spec.image)).toEqual({ user: 'agent' });
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${API}/images/${image}/json`, `POST ${API}/images/create`, `GET ${API}/images/${image}/json`]);
    expect(api.seen[1]!.query.get('fromImage')).toBe(spec.image);
  });

  it('a pull whose stream carries an error fails with it', async () => {
    api = await startFakeRuntimeApi([on('POST', `${API}/images/create`, { status: 200, text: '{"error":"manifest unknown"}\n' })]);
    await expect(createDockerRuntime(api.socket).pull(spec.image)).rejects.toThrow(`docker could not pull ${spec.image}: manifest unknown`);
  });

  it('build sends the Containerfile in a tar, only when the image is not there yet; a stream error fails it (issue #716)', async () => {
    const tag = 'localhost/hopper-box-tools:0123456789abcdef';
    let present = false;
    api = await startFakeRuntimeApi([
      on('GET', `${API}/images/${encodeURIComponent(tag)}/json`, () => (present ? { status: 200, body: { Config: {} } } : { status: 404, body: { message: 'no such image' } })),
      on('POST', `${API}/build`, (r) => {
        if (r.query.get('t') !== tag) return { status: 200, text: '{"errorDetail":{"message":"no match"},"error":"no match"}\n' };
        present = true;
        return { status: 200, text: '{"stream":"Step 1/4"}\n' };
      }),
    ]);
    const rt = createDockerRuntime(api.socket);
    await rt.build(tag, 'FROM example.org/kube-box:1\n');
    const build = api.seen.find((r) => r.path === `${API}/build`)!;
    expect(build.query.get('dockerfile')).toBe('Containerfile');
    expect(String(build.body)).toContain('FROM example.org/kube-box:1\n');
    api.seen.length = 0;
    await rt.build(tag, 'FROM example.org/kube-box:1\n');
    expect(api.seen.map((r) => r.method)).toEqual(['GET']);
    await expect(rt.build('localhost/x:1', 'FROM x\n')).rejects.toThrow('docker could not build localhost/x:1: no match');
  });

  it('listVolumes answers the volumes with every label asked, by name, through a machine\'s relay too (issue #1371)', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/volumes`, { status: 200, body: { Volumes: [{ Name: 'hopper-check-a-home', Labels: { 'io.hopper.check': 'i-1' } }], Warnings: null } }),
    ]);
    const rt = createDockerRuntime(api.socket);
    expect(await rt.listVolumes({ 'io.hopper.check': 'i-1' })).toEqual(['hopper-check-a-home']);
    expect(JSON.parse(api.seen[0]!.query.get('filters')!)).toEqual({ label: ['io.hopper.check=i-1'] });
    expect(await createDockerRuntime('studio', async () => ({ status: 200, text: '{"Volumes":[{"Name":"hopper-check-b-home"}]}' })).listVolumes({ 'io.hopper.need': 'i-1' })).toEqual(['hopper-check-b-home']);
  });

  it('inspect and list read Docker\'s names without the leading slash', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/d0cker/json`, { status: 200, body: { Id: 'd0cker', Name: `/${spec.name}`, Config: { Image: spec.image, Labels: spec.labels }, State: { Status: 'exited' } } }),
      on('GET', `${API}/containers/json`, { status: 200, body: [{ Id: 'd0cker', Names: [`/${spec.name}`], Image: spec.image, Labels: spec.labels, State: 'running' }] }),
    ]);
    const rt = createDockerRuntime(api.socket);
    expect(await rt.inspect('d0cker')).toEqual({ id: 'd0cker', name: spec.name, image: spec.image, labels: spec.labels, state: 'exited' });
    expect(await rt.inspect('gone')).toBeUndefined();
    expect(await rt.list({ 'io.hopper.box': 'i-1' })).toEqual([{ id: 'd0cker', name: spec.name, image: spec.image, labels: spec.labels, state: 'running' }]);
    expect(JSON.parse(api.seen[2]!.query.get('filters')!)).toEqual({ label: ['io.hopper.box=i-1'] });
  });

  it('stop, remove and volumes: gone is no error, and removing keeps the volumes', async () => {
    let made = false;
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/d0cker/json`, { status: 200, body: { Id: 'd0cker', Name: `/${spec.name}`, Config: { Labels: spec.labels }, State: { Status: 'running' } } }),
      on('POST', `${API}/containers/d0cker/start`, { status: 204 }),
      on('POST', `${API}/containers/d0cker/stop`, { status: 204 }),
      on('DELETE', `${API}/containers/d0cker`, { status: 204 }),
      on('POST', `${API}/volumes/create`, () => { made = true; return { status: 201, body: {} }; }),
      on('GET', `${API}/volumes/home`, () => (made ? { status: 200, body: { Name: 'home', Labels: { 'io.hopper.box': 'i-1' } } } : { status: 404, body: { message: 'no such volume' } })),
      on('DELETE', `${API}/volumes/home`, { status: 204 }),
    ]);
    const rt = createDockerRuntime(api.socket);
    await rt.start('d0cker');
    await rt.stop('d0cker');
    await rt.stop('gone');
    await rt.remove('d0cker');
    await rt.remove('gone');
    await rt.createVolume('home', { 'io.hopper.box': 'i-1' });
    await rt.removeVolume('home');
    await rt.removeVolume('gone');
    expect(api.seen.find((r) => r.path === `${API}/containers/d0cker/stop`)!.query.get('t')).toBe('10');
    const removed = api.seen.find((r) => r.method === 'DELETE' && r.path === `${API}/containers/d0cker`)!;
    expect(removed.query.get('force')).toBe('true');
    expect(removed.query.get('v')).toBeNull();
    expect(api.seen.find((r) => r.path === `${API}/volumes/create`)!.body).toEqual({ Name: 'home', Labels: { 'io.hopper.box': 'i-1' } });
  });

  it('stop, remove and removeVolume refuse what carries no sandbox label (issue #1371)', async () => {
    api = await startFakeRuntimeApi([
      on('GET', `${API}/containers/stack/json`, { status: 200, body: { Id: 'stack', Name: '/hopper-hopper-1', Config: { Labels: { 'com.docker.compose.project': 'hopper' } }, State: { Status: 'running' } } }),
      on('GET', `${API}/volumes/hopper_pgdata`, { status: 200, body: { Name: 'hopper_pgdata', Labels: { 'com.docker.compose.project': 'hopper' } } }),
    ]);
    const rt = createDockerRuntime(api.socket);
    await expect(rt.stop('stack')).rejects.toThrow('the hopper leaves the box stack: it carries no sandbox label');
    await expect(rt.remove('stack')).rejects.toThrow('the hopper leaves the box stack: it carries no sandbox label');
    await expect(rt.removeVolume('hopper_pgdata')).rejects.toThrow('the hopper leaves the volume hopper_pgdata: it carries no sandbox label');
    expect(api.seen.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('a rootful Docker is a problem: the hopper launches boxes only through a rootless runtime', async () => {
    let options = ['name=seccomp,profile=builtin'];
    api = await startFakeRuntimeApi([on('GET', `${API}/info`, () => ({ status: 200, body: { SecurityOptions: options } }))]);
    const rt = createDockerRuntime(api.socket);
    expect(rt.kind).toBe('docker');
    expect(await rt.problem()).toMatch(/is not rootless/);
    options = ['name=seccomp,profile=builtin', 'name=rootless'];
    expect(await rt.problem()).toBeUndefined();
  });

  it('a socket nothing listens on is a problem that names the socket', async () => {
    expect(await createDockerRuntime('/nonexistent/docker.sock').problem()).toMatch(/^cannot reach docker at \/nonexistent\/docker\.sock: /);
  });
});
