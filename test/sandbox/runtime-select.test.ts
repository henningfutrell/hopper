// Issue #708: which container runtime the hopper starts boxes through, decided in one place (src/sandbox/runtime.ts).
// The runtimes are API doubles on their sockets (test/support/fake-runtime-api.ts).
//
// Feature: runtime selection
//   Scenario: Podman is the default whenever it is reachable
//   Scenario: Docker when it is configured
//   Scenario: Docker when Podman is given but not reached
//   Scenario: no socket given: no runtime
//   Scenario: a runtime configured with no socket for it is a config error
import { afterEach, describe, expect, it } from 'vitest';
import { selectRuntime } from '../../src/sandbox/runtime.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const apis: FakeRuntimeApi[] = [];
afterEach(async () => { for (const a of apis.splice(0)) await a.close(); });

const podman = async (): Promise<string> => {
  const a = await startFakeRuntimeApi([on('GET', '/v5.0.0/libpod/info', { status: 200, body: { host: { security: { rootless: true } } } })]);
  apis.push(a);
  return a.socket;
};
const docker = async (): Promise<string> => {
  const a = await startFakeRuntimeApi([on('GET', '/v1.41/info', { status: 200, body: { SecurityOptions: ['name=rootless'] } })]);
  apis.push(a);
  return a.socket;
};

describe('runtime selection', () => {
  it('Podman is the default whenever it is reachable', async () => {
    expect((await selectRuntime({ podmanSocket: await podman(), dockerSocket: await docker() }))?.kind).toBe('podman');
  });

  it('Docker when it is configured', async () => {
    expect((await selectRuntime({ podmanSocket: await podman(), dockerSocket: await docker(), runtime: 'docker' }))?.kind).toBe('docker');
  });

  it('Docker when Podman is given but not reached', async () => {
    expect((await selectRuntime({ podmanSocket: '/nonexistent/podman.sock', dockerSocket: await docker() }))?.kind).toBe('docker');
  });

  it('Podman, with its problem, when neither is reached', async () => {
    const rt = await selectRuntime({ podmanSocket: '/nonexistent/podman.sock', dockerSocket: '/nonexistent/docker.sock' });
    expect(rt?.kind).toBe('podman');
    expect(await rt!.problem()).toMatch(/cannot reach podman/);
  });

  it('no socket given: no runtime', async () => {
    expect(await selectRuntime({})).toBeUndefined();
  });

  it('a runtime configured with no socket for it is a config error', async () => {
    await expect(selectRuntime({ podmanSocket: await podman(), runtime: 'docker' })).rejects.toThrow('HOPPER_SANDBOX_RUNTIME=docker needs HOPPER_DOCKER_SOCKET');
  });
});
