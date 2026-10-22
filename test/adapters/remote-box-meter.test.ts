// Issue #947: the sandbox boxes on a client target, read through its remote runtime — the container meter, its calls
// carried down the machine's link by the real hopper client (src/client/runtime.ts) to the machine's own Podman, an API
// double (test/support/fake-libpod.ts).
//
// Feature: the hopper reads what each of its sandbox boxes on a client target uses
//   Scenario: the boxes of this hopper on the machine are read, labelled by the machine; its other containers are left out
//   Scenario: CPU is the cores busy since the read before, as for a box beside the hopper
//   Scenario: only the machines that hold a box of a sandbox record are read, each once
//   Scenario: a machine that is no client target now, or has no runtime, says why; the other machines are still read
//   Scenario: a client that refuses the stats (a release before this one) still gives the boxes' state
//   Scenario: each Podman host given is read over its own stream, labelled by its name (issue #2272)
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeRelay } from '../../src/executors/client.ts';
import { createRemoteBoxMeter } from '../../src/stack-resources/remote.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi, type Handler } from '../support/fake-runtime-api.ts';

const TOKEN = 'a'.repeat(43);
const API = '/v5.0.0/libpod';
const GiB = 1024 ** 3;
const clients: TestClient[] = [];
const apis: FakeRuntimeApi[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const a of apis.splice(0)) await a.close();
});

let usage = 1_000_000_000;
const STATS: Handler = on('GET', new RegExp(`^${API}/containers/[^/]+/stats$`), () => ({
  status: 200,
  body: { cpu_stats: { cpu_usage: { total_usage: usage }, online_cpus: 4 }, precpu_stats: { cpu_usage: {} }, memory_stats: { usage: 300 * 1024 ** 2, limit: 8 * GiB, stats: { inactive_file: 100 * 1024 ** 2 } }, networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } } },
}));

/** A client target named `name`, with its own Podman: two boxes of instance i-1, one of another hopper, one of its own. */
async function machine(handlers: Handler[] = [STATS]) {
  const libpod = createFakeLibpod();
  libpod.put({ name: 'hopper-sandbox-kube', image: 'box:1', labels: { 'io.hopper.box': 'i-1' } });
  libpod.put({ name: 'hopper-sandbox-other', image: 'box:1', labels: { 'io.hopper.box': 'i-2' } });
  libpod.put({ name: 'postgres', image: 'postgres:17', labels: { 'com.docker.compose.project': 'hopper', 'com.docker.compose.service': 'postgres' } });
  const api = await startFakeRuntimeApi([...handlers, ...libpod.handlers]);
  apis.push(api);
  const c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api.socket }) });
  clients.push(c);
  return { api, relay: runtimeRelay(c.transport(TOKEN)) };
}

describe('the sandbox boxes on a client target', () => {
  it('reads the boxes of this hopper on the machine, labelled by the machine; its other containers are left out', async () => {
    const m = await machine();
    let now = 0;
    const meter = createRemoteBoxMeter({
      instanceId: 'i-1', now: () => now,
      records: () => [{ userId: 'u1', machine: 'laptop' }, { userId: 'u1', machine: 'local' }],
      clients: (userId, name) => (userId === 'u1' && name === 'laptop' ? { relay: m.relay } : undefined),
    });
    usage = 1_000_000_000;
    const first = await meter.read();
    expect(first).toHaveLength(1);
    const laptop = first[0]!;
    if (!('containers' in laptop)) throw new Error(laptop.problem);
    expect(laptop.machine).toBe('laptop');
    expect(laptop.containers).toHaveLength(1);
    expect(laptop.containers[0]).toMatchObject({
      service: 'laptop/hopper-sandbox-kube', group: 'sandbox', machine: 'laptop', name: 'hopper-sandbox-kube', image: 'box:1', state: 'running',
      memUsedBytes: 200 * 1024 ** 2, memMaxBytes: 8 * GiB, cores: 4, netRxBytes: 10, netTxBytes: 20,
    });
    // The libpod API, and never the disk use: the client carries no such call.
    expect(m.api.seen.every((s) => s.path.startsWith(API))).toBe(true);
    expect(m.api.seen.some((s) => s.path.endsWith('/system/df'))).toBe(false);

    // Ten seconds later, 5 s of CPU more: half a core.
    now = 10_000;
    usage = 6_000_000_000;
    const second = (await meter.read())[0]!;
    if (!('containers' in second)) throw new Error(second.problem);
    expect(second.containers[0]!.cpuCores).toBeCloseTo(0.5);
  });

  it('reads each machine that holds a box once; one that is no client target now, or has no runtime, says why', async () => {
    const m = await machine();
    const none = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: '/nonexistent/podman.sock' }) });
    clients.push(none);
    const meter = createRemoteBoxMeter({
      instanceId: 'i-1',
      records: () => [{ userId: 'u1', machine: 'laptop' }, { userId: 'u1', machine: 'laptop' }, { userId: 'u1', machine: 'gone' }, { userId: 'u2', machine: 'bare' }],
      clients: (_userId, name) => (name === 'laptop' ? { relay: m.relay } : name === 'bare' ? { relay: runtimeRelay(none.transport(TOKEN)) } : undefined),
    });
    const read = await meter.read();
    expect(read.map((r) => r.machine)).toEqual(['bare', 'gone', 'laptop']);
    expect(read[0]).toEqual({ machine: 'bare', problem: expect.stringContaining('no Podman or Docker socket') });
    expect(read[1]).toEqual({ machine: 'gone', problem: expect.stringContaining('no client target gone') });
    expect(read[2]).toMatchObject({ machine: 'laptop', containers: [expect.objectContaining({ name: 'hopper-sandbox-kube' })] });
    expect(m.api.seen.filter((s) => s.path === `${API}/containers/json`)).toHaveLength(1);
  });

  it('no box on a client target: no machine is read', async () => {
    const meter = createRemoteBoxMeter({ instanceId: 'i-1', records: () => [{ userId: 'u1', machine: 'local' }], clients: () => { throw new Error('not asked'); } });
    expect(await meter.read()).toEqual([]);
  });

  it('a client that refuses the stats (a release before this one) still gives the boxes\' state', async () => {
    const m = await machine();
    const before = { which: m.relay.which, call: async (c: Parameters<typeof m.relay.call>[0]) => (c.path.includes('/stats') ? { status: 403, text: JSON.stringify({ message: 'the hopper client refuses' }) } : m.relay.call(c)) };
    const read = await createRemoteBoxMeter({ instanceId: 'i-1', records: () => [{ userId: 'u1', machine: 'laptop' }], clients: () => ({ relay: before }) }).read();
    expect(read).toEqual([{ machine: 'laptop', containers: [{ service: 'laptop/hopper-sandbox-kube', group: 'sandbox', machine: 'laptop', name: 'hopper-sandbox-kube', image: 'box:1', state: 'running' }] }]);
  });

  it('reads each Podman host given over its own stream, labelled by its name (issue #2272)', async () => {
    const libpod = createFakeLibpod();
    libpod.put({ name: 'hopper-need-box-1', image: 'box:1', labels: { 'io.hopper.box': 'i-1' } });
    libpod.put({ name: 'their-own', image: 'pg:17', labels: {} });
    const api = await startFakeRuntimeApi([STATS, ...libpod.handlers]);
    apis.push(api);
    let streams = 0;
    const socket = { name: 'box-vm', connect: () => { streams++; return connect(api.socket); } };
    const meter = createRemoteBoxMeter({
      instanceId: 'i-1', records: () => [], clients: () => undefined,
      podmanHosts: () => [{ name: 'box-vm', socket }, { name: 'down-vm', socket: { name: 'down-vm', connect: () => connect('/nonexistent/podman.sock') } }],
    });
    const read = await meter.read();
    expect(read.map((r) => r.machine)).toEqual(['box-vm', 'down-vm']);
    expect(read[0]).toMatchObject({ machine: 'box-vm', containers: [expect.objectContaining({ service: 'box-vm/hopper-need-box-1', machine: 'box-vm', memUsedBytes: 200 * 1024 ** 2 })] });
    expect((read[0] as { containers: unknown[] }).containers).toHaveLength(1);
    expect(read[1]).toEqual({ machine: 'down-vm', problem: expect.stringContaining('cannot reach the container runtime on down-vm') });
    expect(streams).toBeGreaterThan(0);
    expect(api.seen.every((x) => x.path.startsWith(API))).toBe(true);
  });
});
