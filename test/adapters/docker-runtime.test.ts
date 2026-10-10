// Issue #708: the Docker container runtime against a Docker Engine API double (test/support/fake-runtime-api.ts): the
// Engine API over its socket, never the docker CLI. The request shapes, the sandbox flags, the limits and the labels.
//
// Feature: the hopper drives Docker through the Docker Engine API
//   Scenario: create sends the sandbox flags, the limits, the labels, the user and the home volume, by name
//   Scenario: pull pulls only a missing image, and answers the user the image runs as
//   Scenario: inspect and list read Docker's names without the leading slash
//   Scenario: stop, remove and volumes: gone is no error, and removing keeps the volumes
//   Scenario: a rootful Docker is a problem: the hopper launches boxes only through a rootless runtime
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
    api = await startFakeRuntimeApi([
      on('POST', `${API}/containers/d0cker/start`, { status: 204 }),
      on('POST', `${API}/containers/d0cker/stop`, { status: 204 }),
      on('DELETE', `${API}/containers/d0cker`, { status: 204 }),
      on('POST', `${API}/volumes/create`, { status: 201, body: {} }),
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
