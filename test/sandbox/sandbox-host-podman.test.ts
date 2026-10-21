// Issue #2272 part 2: a Podman host as the sandbox host. The sandbox host may name a Podman host (the config record
// `podman-hosts`); a step then starts there, through its runtime, and never beside the hopper or on a machine of the
// user's. A box step with vault secrets runs there too: they go in by a copy, as beside the hopper; on a machine of the
// user's it is still refused. A Podman host whose runtime does not answer is offline. The sweep burns a need box a step
// left there, and a run on a Podman host the user removed is closed in the ledger.
// The runtime beside the hopper and the Podman host's are doubles at their port.
//
// Feature: a Podman host as the sandbox host
//   Scenario: named, a step runs there and not beside the hopper
//   Scenario: a box step with vault secrets runs there; on a machine of the user's it does not
//   Scenario: its runtime does not answer: the step waits, and says the host is offline
//   Scenario: the sweep burns a box left there; a run on a removed Podman host is closed
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeRelay } from '../../src/domain/sandboxes.ts';
import { NEED_LABEL, USER_LABEL } from '../../src/sandbox/owned.ts';
import type { ClientTargets } from '../../src/sandbox/runtime.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { NO_SECRET_COPY } from '../../src/sandbox/need-box.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const local = createFakeContainerRuntime(), boxVm = createFakeContainerRuntime();
  const podmanHosts = new Map([['box-vm', boxVm]]);
  // The user's machine `vm` (no coding lanes), dialled in, its Podman reached through its client.
  const libpod = createFakeLibpod();
  const relay: RuntimeRelay = {
    which: async () => ({ kind: 'podman' }),
    call: async (c) => {
      const url = new URL(c.path, 'http://localhost');
      const a = libpod.handlers.map((h) => h({ method: c.method, path: url.pathname, query: url.searchParams, body: c.body })).find((x) => x !== undefined) ?? { status: 404, body: { message: 'no such thing' } };
      return { status: a.status, text: a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body)) };
    },
  };
  const clients: ClientTargets = Object.assign((userId: string, machine: string) => (userId === 'u1' && machine === 'vm' ? { relay } : undefined), {
    dialledIn: (userId: string) => (userId === 'u1' ? ['vm'] : []), allDialledIn: () => [{ userId: 'u1', machine: 'vm' }], known: (userId: string, machine: string) => userId === 'u1' && machine === 'vm',
  });
  const host = { hosts: [] as string[] };
  const runs = memorySandboxRuns();
  const sandboxes = createSandboxes({
    runtime: local, repo: { list: () => [], remove: () => true }, runs, instanceId: 'test', network: 'host', clients, sandboxHost: () => host.hosts,
    podmanHosts: (userId, name) => (userId === 'u1' ? podmanHosts.get(name) : undefined),
    clock: { now: () => NOW }, logger: { info() {}, warn() {} },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-host-podman-'));
  dirs.push(dir);
  const step = (name: string, id: string, secrets?: Record<string, string>) => sandboxes.needStep('u1', { name, template: { image: 'img' }, env: {}, timeoutMs: 5000, dir, ...(secrets ? { files: { secrets } } : {}) }, { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: id, template: 'asked-1' });
  return { local, boxVm, podmanHosts, libpod, host, runs, sandboxes, step };
}

describe('a Podman host as the sandbox host (issue #2272)', () => {
  it('named, a step runs there and not beside the hopper', async () => {
    const { local, boxVm, host, runs, step, sandboxes } = setup();
    host.hosts = ['box-vm'];
    expect((await step('hopper-need-asked-1-aaaa', 's-1')).exit).toBe(0);
    expect(boxVm.ran.has('hopper-need-asked-1-aaaa')).toBe(true);
    expect(local.ran.size).toBe(0);
    expect(runs.all()[0]).toMatchObject({ machine: 'box-vm' });
    expect(await sandboxes.hostOffline('u1')).toBeUndefined();
  });

  it('a box step with vault secrets runs there by a copy; on a machine of the user\'s it does not', async () => {
    const { boxVm, host, step } = setup();
    host.hosts = ['box-vm'];
    // The double's box ends as it starts: the copy is only recorded.
    boxVm.copyIn = async (id, dir) => { boxVm.copies.push({ box: [...boxVm.boxes.values()].find((b) => b.id === id)!.spec.name, dir }); };
    expect(await step('hopper-need-asked-1-aaaa', 's-1', { 'db-password': 'hunter2' })).toEqual({ exit: 0 });
    expect(boxVm.copies.some((c) => c.box === 'hopper-need-asked-1-aaaa')).toBe(true);
    host.hosts = ['vm'];
    expect(await step('hopper-need-asked-1-bbbb', 's-2', { 'db-password': 'hunter2' })).toEqual({ exit: 125, problem: NO_SECRET_COPY });
  });

  it('its runtime does not answer: the step does not start anywhere, and says the host is offline', async () => {
    const { local, boxVm, host, runs, step, sandboxes } = setup();
    host.hosts = ['box-vm'];
    boxVm.down = 'cannot reach podman on box-vm: ssh to box-vm failed (exit 255)';
    expect(await step('hopper-need-asked-1-aaaa', 's-1')).toEqual({ exit: 125, problem: 'sandbox host box-vm is offline' });
    expect(local.ran.size).toBe(0);
    expect(runs.all()).toEqual([]);
    expect(await sandboxes.hostOffline('u1')).toBe('sandbox host box-vm is offline');
    // A Podman host the user does not have is offline as well: nothing else takes its steps.
    host.hosts = ['gone-vm'];
    expect(await sandboxes.hostOffline('u1')).toBe('sandbox host gone-vm is offline');
  });

  it('the sweep burns a need box left there, and a run on a Podman host the user removed is closed', async () => {
    const { boxVm, podmanHosts, host, runs, step, sandboxes } = setup();
    host.hosts = ['box-vm'];
    expect((await step('hopper-need-asked-1-aaaa', 's-1')).exit).toBe(0);
    // A box a stopped hopper left there, with a run still open.
    const id = await boxVm.create({ name: 'hopper-need-asked-1-left', image: 'img', network: 'host', volume: 'v', labels: { [NEED_LABEL]: 'test', [USER_LABEL]: 'u1' }, user: 'agent', env: {}, limits: { cpus: 1, memoryMb: 512 } });
    runs.start({ id: 's-left', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-left', machine: 'box-vm', startedAt: NOW.toISOString() });
    await sandboxes.check();
    expect(boxVm.boxes.has('hopper-need-asked-1-left') || [...boxVm.boxes.values()].some((b) => b.id === id)).toBe(false);
    expect(runs.all().find((r) => r.id === 's-left')).toMatchObject({ outcome: 'swept', destroyedAt: NOW.toISOString() });
    // Removed from the user's Podman hosts: its open run is closed, as no runtime is there to say its box went.
    runs.start({ id: 's-gone', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-gone', machine: 'box-vm', startedAt: NOW.toISOString() });
    podmanHosts.delete('box-vm');
    await sandboxes.check();
    expect(runs.all().find((r) => r.id === 's-gone')).toMatchObject({ outcome: 'swept', destroyedAt: NOW.toISOString() });
  });
});
