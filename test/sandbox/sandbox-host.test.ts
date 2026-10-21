// Issue #2272: the sandbox host. An admin names the machines a user's sandboxes start on, first first. While it is set,
// a sandbox starts only on the first of them that is online — never beside the hopper or on another machine of the user's
// when neither is named —, and none online is "sandbox host <name> is offline". A change applies to the next sandbox; one
// that runs already ends where it started. Not set, sandboxes start where they did before. The runtime beside the hopper
// is a double at its port; each client target's Podman a libpod double reached through a relay, as its client carries
// the calls.
//
// Feature: the sandbox host
//   Scenario: not set, a step runs beside the hopper, as before
//   Scenario: set to a machine, a step runs there and not beside the hopper
//   Scenario: the first machine of the sandbox host that is online takes the step
//   Scenario: no machine of the sandbox host online: the step does not start anywhere, and says the host is offline
//   Scenario: the read-only check and the warm pass find no place while the sandbox host is offline
//   Scenario: a host change mid-run: the running step ends where it started, the next one starts on the new host
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeRelay, SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { createPlacements, type ClientTargets } from '../../src/sandbox/runtime.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memoryRepo(): SandboxRepository {
  const rows = new Map<string, SandboxRecord>();
  return { list: () => [...rows.values()], add: (r) => (rows.has(r.id) ? false : (rows.set(r.id, r), true)), remove: (id) => rows.delete(id) };
}

/** The calls a client carries, answered by the libpod double's handlers. */
const relayTo = (libpod: FakeLibpod): RuntimeRelay => ({
  which: async () => ({ kind: 'podman' }),
  call: async (c) => {
    const url = new URL(c.path, 'http://localhost');
    const r = { method: c.method, path: url.pathname, query: url.searchParams, body: c.body };
    const a = libpod.handlers.map((h) => h(r)).find((x) => x !== undefined) ?? { status: 404, body: { message: 'no such thing' } };
    return { status: a.status, text: a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body)) };
  },
});

function setup() {
  const local = createFakeContainerRuntime();
  // The user u1 has two client targets with no coding lanes: vm and studio; each is dialled in until a test says not.
  const machines = { vm: { libpod: createFakeLibpod(), dialledIn: true }, studio: { libpod: createFakeLibpod(), dialledIn: true } };
  type Name = keyof typeof machines;
  const isName = (m: string): m is Name => m in machines;
  const clients: ClientTargets = Object.assign(
    (userId: string, machine: string) => (userId === 'u1' && isName(machine) && machines[machine].dialledIn ? { relay: relayTo(machines[machine].libpod) } : undefined),
    {
      dialledIn: (userId: string) => (userId === 'u1' ? (Object.keys(machines) as Name[]).filter((m) => machines[m].dialledIn) : []),
      allDialledIn: () => (Object.keys(machines) as Name[]).filter((m) => machines[m].dialledIn).map((machine) => ({ userId: 'u1', machine })),
      known: (userId: string, machine: string) => userId === 'u1' && isName(machine),
    },
  );
  const host = { hosts: [] as string[] };
  const runs = memorySandboxRuns();
  const sandboxes = createSandboxes({
    runtime: local, repo: memoryRepo(), runs, instanceId: 'test', network: 'host', clients, sandboxHost: () => host.hosts,
    clock: { now: () => NOW }, logger: { info() {}, warn() {} },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-host-'));
  dirs.push(dir);
  const step = (name: string, id: string) => sandboxes.needStep('u1', { name, template: { image: 'img' }, env: { HOPPER_NEED_TOKEN: 'minted' }, timeoutMs: 5000, dir }, { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: id, template: 'asked-1' });
  const createdOn = (m: Name): unknown[] => [...machines[m].libpod.containers.values()];
  return { local, machines, clients, host, runs, sandboxes, step, createdOn };
}

describe('the sandbox host (issue #2272)', () => {
  it('not set, a step runs beside the hopper, as before', async () => {
    const { local, runs, step } = setup();
    expect((await step('hopper-need-asked-1-aaaa', 's-1')).exit).toBe(0);
    expect(local.ran.has('hopper-need-asked-1-aaaa')).toBe(true);
    expect(runs.all()[0]).toMatchObject({ machine: 'local' });
  });

  it('set to a machine, a step runs there and not beside the hopper', async () => {
    const { local, host, runs, step, sandboxes } = setup();
    host.hosts = ['vm'];
    const r = await step('hopper-need-asked-1-aaaa', 's-1');
    expect(r).toMatchObject({ exit: 0 });
    expect(local.ran.size).toBe(0);
    expect(runs.all()[0]).toMatchObject({ machine: 'vm' });
    expect(await sandboxes.hostOffline('u1')).toBeUndefined();
  });

  it('the first machine of the sandbox host that is online takes the step', async () => {
    const { machines, host, runs, step } = setup();
    host.hosts = ['vm', 'studio'];
    machines.vm.dialledIn = false;
    expect((await step('hopper-need-asked-1-aaaa', 's-1')).exit).toBe(0);
    expect(runs.all()[0]).toMatchObject({ machine: 'studio' });
    machines.vm.dialledIn = true;
    expect((await step('hopper-need-asked-1-bbbb', 's-2')).exit).toBe(0);
    expect(runs.all().find((r) => r.id === 's-2')).toMatchObject({ machine: 'vm' });
  });

  it('no machine of the sandbox host online: the step does not start anywhere, and says the host is offline', async () => {
    const { local, machines, host, runs, step, sandboxes, createdOn } = setup();
    host.hosts = ['vm'];
    machines.vm.dialledIn = false;
    // studio is dialled in, and the hopper has a runtime beside it: neither is a fallback.
    expect(await step('hopper-need-asked-1-aaaa', 's-1')).toEqual({ exit: 125, problem: 'sandbox host vm is offline' });
    expect(local.ran.size).toBe(0);
    expect(createdOn('studio')).toEqual([]);
    expect(runs.all()).toEqual([]);
    expect(await sandboxes.hostOffline('u1')).toBe('sandbox host vm is offline');
    expect(await sandboxes.stepProblem('u1')).toBe('sandbox host vm is offline');
    // A host whose runtime does not answer is offline too.
    host.hosts = ['local', 'vm'];
    local.down = 'cannot reach podman';
    expect(await sandboxes.hostOffline('u1')).toBe('sandbox hosts local, vm are offline');
    // Not set: nothing waits for a host.
    host.hosts = [];
    expect(await sandboxes.hostOffline('u1')).toBeUndefined();
  });

  it('the read-only check and the warm pass find no place while the sandbox host is offline', async () => {
    const { local, machines, clients } = setup();
    const hosts: string[] = ['vm'];
    const places = createPlacements({ local, network: 'host', clients, hosts: () => hosts });
    expect(await places.forCheck('u1')).toMatchObject({ machine: 'vm' });
    machines.vm.dialledIn = false;
    expect(await places.forCheck('u1')).toBeUndefined();
    expect(await places.where('u1')).toEqual({ problem: 'sandbox host vm is offline', offline: true });
    hosts.splice(0, 1, 'local');
    expect(await places.forCheck('u1')).toMatchObject({ machine: 'local', runtime: local });
  });

  it('a host change mid-run: the running step ends where it started, the next one starts on the new host', async () => {
    const { local, host, runs, step } = setup();
    host.hosts = ['local'];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    local.runScript = async () => { await held; return { exit: 0, output: '' }; };
    const first = step('hopper-need-asked-1-aaaa', 's-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(local.boxes.has('hopper-need-asked-1-aaaa')).toBe(true);
    host.hosts = ['vm'];
    expect((await step('hopper-need-asked-1-bbbb', 's-2')).exit).toBe(0);
    release();
    expect((await first).exit).toBe(0);
    expect(runs.all().map((r) => [r.id, r.machine]).sort()).toEqual([['s-1', 'local'], ['s-2', 'vm']]);
  });
});
