// Issue #2272 part 3: a Podman host on Machines. Its status is read from libpod /info over its stream: whether boxes can
// start there (the same health as the sandbox module's), and its CPU and memory now, to size it from real numbers. A host
// that cannot be reached, or whose Podman is rootful, says why, and has no numbers.
// The host's Podman is a libpod double on a unix socket, reached through a stream as the ssh one is.
//
// Feature: a Podman host's status
//   Scenario: online: its CPUs, the share busy, its memory in use and in all
//   Scenario: not reached: it says why, with no numbers
//   Scenario: rootful: it says so, as the sandbox module does
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readPodmanHostStatus } from '../../src/sandbox/podman-host-status.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const GiB = 1024 ** 3;
const AT = new Date('2026-10-21T12:00:00.000Z');
const apis: FakeRuntimeApi[] = [];
afterEach(async () => { for (const a of apis.splice(0)) await a.close(); });

async function host(info: unknown) {
  const api = await startFakeRuntimeApi([on('GET', /^\/v5\.0\.0\/libpod\/info$/, () => ({ status: 200, body: info })), ...createFakeLibpod().handlers]);
  apis.push(api);
  return { name: 'box-vm', connect: () => connect(api.socket) };
}

describe('a Podman host\'s status (issue #2272)', () => {
  it('online: its CPUs, the share busy, its memory in use and in all', async () => {
    const socket = await host({ host: { security: { rootless: true }, cpus: 8, memTotal: 16 * GiB, memFree: 6 * GiB, cpuUtilization: { userPercent: 20, systemPercent: 5, idlePercent: 75 } } });
    expect(await readPodmanHostStatus('box-vm', socket, AT)).toEqual({ name: 'box-vm', at: AT.toISOString(), cpus: 8, cpuBusyFrac: 0.25, memTotalBytes: 16 * GiB, memUsedBytes: 10 * GiB });
  });

  it('not reached: it says why, with no numbers', async () => {
    const socket = { name: 'box-vm', connect: () => connect('/nonexistent/podman.sock') };
    expect(await readPodmanHostStatus('box-vm', socket, AT)).toEqual({ name: 'box-vm', at: AT.toISOString(), problem: expect.stringMatching(/^cannot reach podman on box-vm: /) });
  });

  it('rootful: it says so, as the sandbox module does', async () => {
    const socket = await host({ host: { security: { rootless: false }, cpus: 8 } });
    expect(await readPodmanHostStatus('box-vm', socket, AT)).toEqual({ name: 'box-vm', at: AT.toISOString(), problem: 'podman at box-vm is not rootless: the hopper launches sandbox boxes only through a rootless runtime' });
  });
});
