// Issue #947: the container meter against a container runtime API double (test/support/fake-runtime-api.ts). Podman and
// Docker both serve the Docker-compatible API this reads, so one double stands for both.
//
// Feature: the hopper reads what each container of its stack and each sandbox box uses, from the container runtime
//   Scenario: the containers of the hopper's own compose project and its own boxes are read; others are left out
//   Scenario: CPU is the cores busy since the read before; a first read gives none unless the runtime says
//   Scenario: memory is the use less the page cache it could drop, against its limit; no limit is none
//   Scenario: the cores it sees and the most memory it may use (its limit, else the computer's) come from its stats
//   Scenario: network and disk bytes are summed; restarts, start time and health come from inspect
//   Scenario: the writable layer and each named volume carry their size from the disk use
//   Scenario: a container that does not run is listed with its state and no use
//   Scenario: a hopper not in a container reads the project `hopper`
//   Scenario: a runtime that does not answer is a problem, not an error
import { afterEach, describe, expect, it } from 'vitest';
import { createContainerMeter } from '../../src/stack-resources/containers.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi, type Handler } from '../support/fake-runtime-api.ts';

let api: FakeRuntimeApi | undefined;
afterEach(async () => { await api?.close(); api = undefined; });

const GiB = 1024 ** 3;
const project = (name: string, service: string) => ({ 'com.docker.compose.project': name, 'com.docker.compose.service': service });

const LISTED = [
  { Id: 'aaa111hopper', Names: ['/hopper-hopper-1'], Image: 'ghcr.io/henningfutrell/hopper:latest', Labels: project('hopper', 'hopper'), State: 'running' },
  { Id: 'bbb222postgres', Names: ['/hopper-postgres-1'], Image: 'postgres:17-alpine', Labels: project('hopper', 'postgres'), State: 'running' },
  { Id: 'ccc333kms', Names: ['/hopper-kms-1'], Image: 'nsmithuk/local-kms:3.12.0', Labels: project('hopper', 'kms'), State: 'exited' },
  { Id: 'ddd444box', Names: ['/hopper-sandbox-claude'], Image: 'box:1', Labels: { 'io.hopper.box': 'i-1' }, State: 'running' },
  { Id: 'eee555other', Names: ['/other-db-1'], Image: 'postgres:16', Labels: project('other', 'db'), State: 'running' },
  { Id: 'fff666otherbox', Names: ['/hopper-sandbox-x'], Image: 'box:1', Labels: { 'io.hopper.box': 'i-2' }, State: 'running' },
];

const INSPECT: Record<string, unknown> = {
  aaa111hopper: { State: { Status: 'running', StartedAt: '2026-10-12T10:00:00Z' }, RestartCount: 0, HostConfig: {}, Mounts: [{ Type: 'volume', Name: 'hopper_home' }] },
  bbb222postgres: {
    State: { Status: 'running', StartedAt: '2026-10-12T09:00:00.123456789Z', Health: { Status: 'healthy' } }, RestartCount: 2,
    HostConfig: { NanoCpus: 2_000_000_000, Memory: 2 * GiB }, Mounts: [{ Type: 'volume', Name: 'hopper_postgres' }, { Type: 'bind', Source: '/x' }],
  },
  ccc333kms: { State: { Status: 'exited', StartedAt: '2026-10-12T08:00:00Z' }, RestartCount: 0, HostConfig: {}, Mounts: [] },
  ddd444box: { State: { Status: 'running', StartedAt: '0001-01-01T00:00:00Z' }, RestartCount: 0, HostConfig: { CpuQuota: 150_000, CpuPeriod: 100_000 }, Mounts: [] },
};

let usage = 1_000_000_000;
const stats = (id: string) => ({
  cpu_stats: { cpu_usage: { total_usage: id === 'bbb222postgres' ? usage : 5_000_000_000 }, online_cpus: 8 },
  precpu_stats: { cpu_usage: {} },
  memory_stats: { usage: 600 * 1024 * 1024, limit: id === 'bbb222postgres' ? 2 * GiB : 16 * GiB, stats: { inactive_file: 100 * 1024 * 1024 } },
  networks: { eth0: { rx_bytes: 1000, tx_bytes: 200 }, eth1: { rx_bytes: 24, tx_bytes: 6 } },
  blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 4096 }, { op: 'Write', value: 8192 }, { op: 'read', value: 4096 }] },
});

const DF = {
  Containers: [{ Id: 'bbb222postgres', SizeRw: 12_345 }],
  Volumes: [{ Name: 'hopper_postgres', UsageData: { Size: 50_000_000 } }, { Name: 'hopper_home', UsageData: { Size: -1 } }],
};

const runtimeApi = (extra: Handler[] = []): Handler[] => [
  ...extra,
  on('GET', '/containers/json', { status: 200, body: LISTED }),
  on('GET', /^\/containers\/[^/]+\/json$/, (r) => {
    const id = r.path.split('/')[2]!;
    return INSPECT[id] ? { status: 200, body: { Id: id, ...(INSPECT[id] as object) } } : { status: 404, body: { message: 'no such container' } };
  }),
  on('GET', /^\/containers\/[^/]+\/stats$/, (r) => ({ status: 200, body: stats(r.path.split('/')[2]!) })),
  on('GET', '/system/df', { status: 200, body: DF }),
];

describe('the container meter', () => {
  it('reads the containers of its own compose project and its own boxes, labelled by service', async () => {
    api = await startFakeRuntimeApi(runtimeApi());
    let now = 0;
    const meter = createContainerMeter({ socket: api.socket, self: 'aaa111hopper', instanceId: 'i-1', now: () => now });
    usage = 1_000_000_000;
    const first = await meter.read();
    if (!('containers' in first)) throw new Error(first.problem);
    expect(first.containers.map((c) => [c.group, c.service])).toEqual([
      ['stack', 'hopper'], ['stack', 'kms'], ['stack', 'postgres'], ['sandbox', 'hopper-sandbox-claude'],
    ]);
    const pg = first.containers.find((c) => c.service === 'postgres')!;
    // A first read: no CPU yet (the runtime gave no earlier one).
    expect(pg.cpuCores).toBeUndefined();
    expect(pg).toMatchObject({
      name: 'hopper-postgres-1', image: 'postgres:17-alpine', state: 'running', health: 'healthy', restarts: 2,
      startedAt: '2026-10-12T09:00:00.123Z', cpuLimitCores: 2,
      memUsedBytes: 500 * 1024 * 1024, memLimitBytes: 2 * GiB, memMaxBytes: 2 * GiB, cores: 8,
      netRxBytes: 1024, netTxBytes: 206, diskReadBytes: 8192, diskWriteBytes: 8192,
      layerBytes: 12_345, volumes: [{ name: 'hopper_postgres', bytes: 50_000_000 }],
    });
    // No memory limit set: none, though the runtime says the computer's memory.
    expect(first.containers.find((c) => c.service === 'hopper')).toMatchObject({ volumes: [{ name: 'hopper_home' }] });
    expect(first.containers.find((c) => c.service === 'hopper')!.memLimitBytes).toBeUndefined();
    // What it may use at most is the computer's memory then: the share of it the history keeps (issue #947).
    expect(first.containers.find((c) => c.service === 'hopper')!.memMaxBytes).toBe(16 * GiB);
    expect(first.containers.find((c) => c.service === 'hopper-sandbox-claude')).toMatchObject({ cpuLimitCores: 1.5 });
    expect(first.containers.find((c) => c.service === 'hopper-sandbox-claude')!.startedAt).toBeUndefined();

    // Ten seconds later, 5 s of CPU more: half a core.
    now = 10_000;
    usage = 6_000_000_000;
    const second = await meter.read();
    if (!('containers' in second)) throw new Error(second.problem);
    expect(second.containers.find((c) => c.service === 'postgres')!.cpuCores).toBeCloseTo(0.5);
  });

  it('a container that does not run is listed with its state and no use; its stats are not asked', async () => {
    api = await startFakeRuntimeApi(runtimeApi());
    const read = await createContainerMeter({ socket: api.socket, self: 'aaa111hopper', instanceId: 'i-1' }).read();
    if (!('containers' in read)) throw new Error(read.problem);
    const kms = read.containers.find((c) => c.service === 'kms')!;
    expect(kms).toEqual({ service: 'kms', group: 'stack', name: 'hopper-kms-1', image: 'nsmithuk/local-kms:3.12.0', state: 'exited', restarts: 0 });
    expect(api.seen.some((r) => r.path === '/containers/ccc333kms/stats')).toBe(false);
    expect(api.seen.find((r) => r.path.endsWith('/stats'))!.query.get('stream')).toBe('false');
  });

  it('the runtime\'s own CPU reading before counts at a first read', async () => {
    api = await startFakeRuntimeApi(runtimeApi([on('GET', '/containers/bbb222postgres/stats', {
      status: 200,
      body: { ...stats('bbb222postgres'), cpu_stats: { cpu_usage: { total_usage: 3_000_000_000 }, system_cpu_usage: 40_000_000_000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 20_000_000_000 } },
    })]));
    const read = await createContainerMeter({ socket: api.socket, self: 'aaa111hopper', instanceId: 'i-1' }).read();
    if (!('containers' in read)) throw new Error(read.problem);
    // 2 s of CPU in 20 s of the computer's 4 cores' time: 0.4 cores.
    expect(read.containers.find((c) => c.service === 'postgres')!.cpuCores).toBeCloseTo(0.4);
  });

  it('a hopper not in a container reads the project `hopper`', async () => {
    api = await startFakeRuntimeApi(runtimeApi());
    const read = await createContainerMeter({ socket: api.socket, self: 'some-host', instanceId: 'i-1' }).read();
    if (!('containers' in read)) throw new Error(read.problem);
    expect(read.containers.filter((c) => c.group === 'stack').map((c) => c.service)).toEqual(['hopper', 'kms', 'postgres']);
  });

  it('disk use that fails leaves the sizes out, and the rest is read', async () => {
    api = await startFakeRuntimeApi(runtimeApi([on('GET', '/system/df', { status: 500, body: { message: 'busy' } })]));
    const read = await createContainerMeter({ socket: api.socket, self: 'aaa111hopper', instanceId: 'i-1' }).read();
    if (!('containers' in read)) throw new Error(read.problem);
    const pg = read.containers.find((c) => c.service === 'postgres')!;
    expect(pg.layerBytes).toBeUndefined();
    expect(pg.volumes).toEqual([{ name: 'hopper_postgres' }]);
    expect(pg.memUsedBytes).toBe(500 * 1024 * 1024);
  });

  it('a runtime that does not answer is a problem, not an error', async () => {
    const read = await createContainerMeter({ socket: '/nonexistent/api.sock', self: 'x', instanceId: 'i-1' }).read();
    expect(read).toEqual({ problem: expect.stringContaining('cannot reach the container runtime at /nonexistent/api.sock') });
    api = await startFakeRuntimeApi([on('GET', '/containers/json', { status: 403, body: { message: 'denied' } })]);
    expect(await createContainerMeter({ socket: api.socket, self: 'x', instanceId: 'i-1' }).read()).toEqual({ problem: 'the container runtime refused to list containers (403): denied' });
  });
});
