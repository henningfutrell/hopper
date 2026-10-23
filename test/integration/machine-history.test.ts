// Machine resources over time (issue #560) through the real daemon, store and HTTP server: a machine's probe
// carries its CPU, memory, swap and disk on its snapshot; the resource recorder keeps one machine sample per
// online machine with readings, with its lanes in use; an offline machine adds nothing, which the graph shows
// as a gap; GET /api/machines/:id/history and GET /api/machines/history answer the resource graph per graph
// step; new samples are pushed as machine.recorded; the history retention prunes them with the usage samples.
// One machine's graph also carries the usage that limits it and its lane changes (issue #688, lane tuning's graph).
// The probe is the seam: no ssh here.
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineHistory, MachineSample, ResourceReading, UsageSample } from '../../src/domain/types.ts';
import type { MachineProbe } from '../../src/machines/index.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { openSse, type SseClient } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
let sse: SseClient | undefined;
afterEach(async () => {
  sse?.close();
  sse = undefined;
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const GIB = 1024 ** 3;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RES: ResourceReading = { cores: 8, cpuBusyFrac: 0.25, load: [2, 1.5, 1], memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB, swapTotalBytes: 8 * GIB, swapUsedBytes: 2 * GIB };

/** One attached machine `laptop`, no other; its probe answers what `probe.now` says. */
async function boot(online = true, resources: ResourceReading = RES): Promise<TestApp & { probe: { now: MachineProbe } }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'test', plugin: 'test' }],
    machines: [{ name: 'laptop', plugin: 'ssh', options: { label: 'arch-laptop', ssh: 'laptop', lanes: 4, executors: ['test'] } }],
  });
  const probe = { now: (online ? { online: true, home: '/home/far', disk: { freeBytes: 25 * GIB, totalBytes: 100 * GIB, low: false }, resources } : { online: false }) as MachineProbe };
  const a = await startTestApp({ dbPath: db.dbPath, seams: { machineProbe: () => Promise.resolve(probe.now) } });
  apps.push(a);
  return Object.assign(a, { probe });
}

const onlineWith = async (a: TestApp, ok: (m: { online: boolean; resources?: ResourceReading }) => boolean) =>
  waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean; resources?: ResourceReading }[]).find((m) => m.id === 'laptop' && ok(m)));

const history = async (a: TestApp, path: string) => a.api<MachineHistory>('GET', path);
const sample = (at: number, cpu: number, over: Partial<MachineSample> = {}): MachineSample => ({
  machineId: 'laptop', at: new Date(at).toISOString(), cpuBusyFrac: cpu, cores: 8, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB,
  diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, lanesBusy: 1, lanesMax: 4, ...over,
});

describe('machine resources over time', () => {
  it('a machine\'s snapshot carries its resources; each record keeps one machine sample of it', async () => {
    const a = await boot();
    const m = await onlineWith(a, (x) => x.online && x.resources !== undefined);
    expect(m.resources).toEqual(RES);
    expect(await a.user().machineHistory.record()).toBe(1);

    const r = await history(a, '/api/machines/laptop/history?range=24h');
    expect(r.status).toBe(200);
    expect(r.body.view).toEqual({ range: { preset: '24h' } });
    expect(Date.parse(r.body.to) - Date.parse(r.body.from)).toBe(DAY);
    const last = (resource: string) => r.body.series.find((s) => s.machineId === 'laptop' && s.resource === resource)?.points.at(-1)?.usedFrac;
    expect(last('cpu')).toBeCloseTo(0.25);
    expect(last('memory')).toBeCloseTo(0.75);
    expect(last('swap')).toBeCloseTo(0.25);
    expect(last('disk')).toBeCloseTo(0.75);
    expect(last('lanes')).toBe(0);
  });

  it('an offline machine adds nothing, and its snapshot carries no resources', async () => {
    const a = await boot(false);
    const m = await onlineWith(a, (x) => !x.online);
    expect(m).not.toHaveProperty('resources');
    expect(await a.user().machineHistory.record()).toBe(0);
  });

  it('per graph step the peak; a stretch with no sample is a gap; the step is finer than usage\'s for a day', async () => {
    const a = await boot();
    const to = Date.parse('2026-10-08T12:00:00.000Z');
    const t0 = to - 6 * HOUR;
    const kept = a.user().store.machineHistory.record([
      sample(t0, 0.1), sample(t0 + MIN, 0.6), sample(t0 + 2 * MIN, 0.2),
      // Offline for two hours.
      sample(t0 + 2 * HOUR, 0.3), sample(t0 + 2 * HOUR + MIN, 0.4),
    ]);
    expect(kept).toBe(5);
    const r = await history(a, `/api/machines/laptop/history?from=${new Date(to - 6 * HOUR).toISOString()}&to=${new Date(to).toISOString()}`);
    expect(r.body.stepMs).toBe(15 * MIN);
    const cpu = r.body.series.find((s) => s.resource === 'cpu')!;
    expect(cpu.points.map((p) => p.usedFrac)).toEqual([0.6, 0.4]);
    expect(cpu.gaps).toEqual([{ from: new Date(t0 + 2 * MIN).toISOString(), to: new Date(t0 + 2 * HOUR).toISOString() }]);
    expect(r.body.series.find((s) => s.resource === 'lanes')!.points.map((p) => p.usedFrac)).toEqual([0.25, 0.25]);
    // A sample at the same time is kept once.
    expect(a.user().store.machineHistory.record([sample(t0, 0.9)])).toBe(0);
  });

  it('every machine\'s lines at once; a machine with no samples in range has none', async () => {
    const a = await boot();
    const now = Date.now();
    a.user().store.machineHistory.record([sample(now - HOUR, 0.5), sample(now - HOUR, 0.7, { machineId: 'desk' })]);
    const all = await history(a, '/api/machines/history?range=24h');
    expect(new Set(all.body.series.map((s) => s.machineId))).toEqual(new Set(['laptop', 'desk']));
    const one = await history(a, '/api/machines/desk/history?range=24h');
    expect(new Set(one.body.series.map((s) => s.machineId))).toEqual(new Set(['desk']));
    expect((await history(a, '/api/machines/nowhere/history?range=24h')).body.series).toEqual([]);
    expect((await history(a, '/api/machines/history?range=2y')).status).toBe(400);
  });

  it('new samples are pushed on the event stream as machine.recorded (no id)', async () => {
    const a = await boot();
    await onlineWith(a, (x) => x.online);
    sse = await openSse(`${a.url}/api/events/stream`);
    await a.user().machineHistory.record();
    const m = await waitFor(() => sse!.messages.find((x) => x.event === 'machine.recorded'));
    expect(m.id).toBeUndefined();
    expect(JSON.parse(m.data)).toEqual({ added: 1 });
  });

  it('the history retention prunes machine samples too, at once', async () => {
    const a = await boot();
    const admin = await a.login();
    const now = Date.now();
    a.user().store.machineHistory.record([sample(now - 10 * DAY, 0.1), sample(now - 2 * DAY, 0.2)]);
    expect((await a.ui('/ui/api/usage-history/retention', { days: 5 }, { token: admin })).status).toBe(200);
    const r = await history(a, '/api/machines/laptop/history?range=30d');
    expect(r.body.retentionDays).toBe(5);
    // The live machine's own samples, recorded since it started, are kept; the one 10 days old is gone.
    const cpu = r.body.series.find((s) => s.resource === 'cpu')!.points.map((p) => p.usedFrac);
    expect(cpu).toContain(0.2);
    expect(cpu).not.toContain(0.1);
  });
});

describe('lanes and usage on one machine\'s graph (issue #688)', () => {
  const reading = (at: number, used: number, over: Partial<UsageSample> = {}): UsageSample =>
    ({ source: 'claude', machineId: 'laptop', window: 'session', used, limit: 100, unit: '%', at: new Date(at).toISOString(), ...over });

  it('one machine\'s graph carries the usage that limits it — its own readings and a budget every machine shares — and its lane changes in range', async () => {
    const a = await boot();
    const now = Date.now();
    const store = a.user().store;
    store.machineHistory.record([sample(now - HOUR, 0.5, { lanesBusy: 2 })]);
    store.usageHistory.record([
      reading(now - HOUR, 40), reading(now - HOUR + 5 * MIN, 60),
      reading(now - HOUR, 90, { machineId: 'desk' }),
      { source: 'claude', window: 'week', used: 30, limit: 100, unit: '%', at: new Date(now - HOUR).toISOString() },
    ]);
    const applied = { machineId: 'laptop', from: 2, to: 4, reason: '4 lanes run without pressure', confidence: 1, by: 'admin' };
    store.events.append({ type: 'lanes.applied', at: new Date(now - 2 * DAY).toISOString(), data: { ...applied, from: 1, to: 2 } });
    store.events.append({ type: 'lanes.applied', at: new Date(now - 30 * MIN).toISOString(), data: applied });
    store.events.append({ type: 'lanes.applied', at: new Date(now - 25 * MIN).toISOString(), data: { ...applied, machineId: 'desk' } });
    store.events.append({ type: 'lanes.undone', at: new Date(now - 20 * MIN).toISOString(), data: { machineId: 'laptop', from: 4, to: 2, by: 'admin' } });

    const r = await history(a, '/api/machines/laptop/history?range=24h');
    expect(r.status).toBe(200);
    // The test app's own usage source reads a budget every machine shares too: only the seeded account here.
    const usage = r.body.usage!.filter((s) => s.account === 'claude');
    expect(usage.map((s) => [s.account, s.window])).toEqual([['claude', 'session'], ['claude', 'week']]);
    expect(Math.max(...usage[0]!.points.map((p) => p.usedFrac))).toBeCloseTo(0.6);
    expect(usage[1]!.points.map((p) => p.usedFrac)).toEqual([0.3]);
    expect(r.body.laneChanges!.map((c) => [c.kind, c.from, c.to])).toEqual([['applied', 2, 4], ['undone', 4, 2]]);
    expect(r.body.laneChanges![0]).toMatchObject({ machineId: 'laptop', reason: '4 lanes run without pressure', by: 'admin' });

    const all = await history(a, '/api/machines/history?range=24h');
    expect(all.body).not.toHaveProperty('usage');
    expect(all.body).not.toHaveProperty('laneChanges');
    const none = await history(a, '/api/machines/nowhere/history?range=24h');
    expect(none.body.usage!.filter((s) => s.account === 'claude').map((s) => s.window)).toEqual(['week']);
    expect(none.body.laneChanges).toEqual([]);
  });
});

describe('the signals admission reads (issue #2499)', () => {
  it('a sample keeps memory pressure and CPU throttle; the graph draws them; a sample with neither has no such line', async () => {
    const a = await boot(true, { ...RES, memPressure: { someAvg10: 30, fullAvg10: 5 }, cpuThrottledFrac: 0.4 });
    await onlineWith(a, (x) => x.resources?.cpuThrottledFrac !== undefined);
    expect(await a.user().machineHistory.record()).toBe(1);
    const r = await history(a, '/api/machines/laptop/history?range=24h');
    const last = (resource: string) => r.body.series.find((s) => s.resource === resource)?.points.at(-1)?.usedFrac;
    expect(last('pressure')).toBeCloseTo(0.3);
    expect(last('throttle')).toBeCloseTo(0.4);

    const b = await boot();
    b.user().store.machineHistory.record([sample(Date.now() - HOUR, 0.5)]);
    const q = await history(b, '/api/machines/laptop/history?range=24h');
    expect(q.body.series.some((s) => s.resource === 'pressure' || s.resource === 'throttle')).toBe(false);
  });
});

describe('the hopper\'s own disk use over time (issue #2494)', () => {
  it('a sample keeps the hopper\'s disk use and the caches from the machine\'s last disk measure; the graph draws them as shares of the disk', async () => {
    const a = await boot();
    await onlineWith(a, (x) => x.online);
    a.user().store.diskMeasures.keep('laptop', {
      at: new Date().toISOString(), paths: [{ path: '/w/.worktrees', bytes: 20 * GIB }],
      caches: [{ kind: 'gradle', path: '/home/far/.gradle/caches', bytes: 10 * GIB }],
    });
    expect(await a.user().machineHistory.record()).toBe(1);
    const r = await history(a, '/api/machines/laptop/history?range=24h');
    const last = (resource: string) => r.body.series.find((s) => s.resource === resource)?.points.at(-1)?.usedFrac;
    expect(last('hopper')).toBeCloseTo(0.2);
    expect(last('caches')).toBeCloseTo(0.1);

    const b = await boot();
    b.user().store.machineHistory.record([sample(Date.now() - HOUR, 0.5)]);
    const q = await history(b, '/api/machines/laptop/history?range=24h');
    expect(q.body.series.some((s) => s.resource === 'hopper' || s.resource === 'caches')).toBe(false);
  });
});

describe('a WSL machine\'s memory and the memory alert (issue #868)', () => {
  const WSL: ResourceReading = {
    cores: 8, memTotalBytes: 20 * GIB, memAvailableBytes: 13 * GIB, wsl: true, vmHeldBytes: 19 * GIB, hostMemFreeBytes: 3 * GIB, hostMemTotalBytes: 32 * GIB,
  };

  it('a sample keeps the memory the VM holds and Windows\' memory; the graph draws them as memory held and host memory', async () => {
    const a = await boot(true, WSL);
    await onlineWith(a, (x) => x.resources?.wsl === true);
    expect(await a.user().machineHistory.record()).toBeGreaterThanOrEqual(1);
    const r = await history(a, '/api/machines/laptop/history?range=24h');
    const last = (resource: string) => r.body.series.find((s) => s.resource === resource)?.points.at(-1)?.usedFrac;
    expect(last('memory')).toBeCloseTo(0.35);
    expect(last('held')).toBeCloseTo(0.95);
    expect(last('host')).toBeCloseTo(29 / 32);
  });

  it('a machine with no WSL figures has no memory held or host memory line', async () => {
    const a = await boot();
    a.user().store.machineHistory.record([sample(Date.now() - HOUR, 0.5)]);
    const r = await history(a, '/api/machines/laptop/history?range=24h');
    expect(r.body.series.some((s) => s.resource === 'held' || s.resource === 'host')).toBe(false);
  });

  it('an admin sets the memory alert; Windows\' free memory under it tells machine.memory_low, back over machine.memory_recovered', async () => {
    const a = await boot(true, WSL);
    const admin = await a.login();
    expect((await history(a, '/api/machines/history?range=24h')).body).not.toHaveProperty('memoryAlert');
    expect((await a.ui('/ui/api/machines/memory-alert', { alert: { freeBytes: 0, minutes: 5 } }, { token: admin })).status).toBe(400);
    const set = await a.ui<{ memoryAlert: unknown }>('/ui/api/machines/memory-alert', { alert: { freeBytes: 5 * GIB, minutes: 0 } }, { token: admin });
    expect(set.status).toBe(200);
    expect(set.body.memoryAlert).toEqual({ freeBytes: 5 * GIB, minutes: 0 });
    expect((await history(a, '/api/machines/history?range=24h')).body.memoryAlert).toEqual({ freeBytes: 5 * GIB, minutes: 0 });

    await onlineWith(a, (x) => x.resources?.wsl === true);
    await a.user().machineHistory.record();
    const low = await waitFor(async () => (await a.events('types=machine.memory_low'))[0]);
    expect(low.data).toMatchObject({ machineId: 'laptop', of: 'windows', freeBytes: 3 * GIB, totalBytes: 32 * GIB, thresholdBytes: 5 * GIB });

    // A lower threshold: the same 3 GiB free is back over it.
    expect((await a.ui('/ui/api/machines/memory-alert', { alert: { freeBytes: 2 * GIB, minutes: 0 } }, { token: admin })).status).toBe(200);
    await a.user().machineHistory.record();
    const back = await waitFor(async () => (await a.events('types=machine.memory_recovered'))[0]);
    expect(back.data).toMatchObject({ machineId: 'laptop', freeBytes: 3 * GIB, thresholdBytes: 2 * GIB });

    const off = await a.ui<{ memoryAlert: unknown }>('/ui/api/machines/memory-alert', { alert: null }, { token: admin });
    expect(off.body.memoryAlert).toBeNull();
    expect((await history(a, '/api/machines/history?range=24h')).body).not.toHaveProperty('memoryAlert');
  });

  it('a WSL machine\'s Windows link (issue #712): the snapshot carries it, and broken tells machine.windows_link_broken once', async () => {
    const link = { url: 'http://localhost:4790/api/health', mode: 'nat', at: new Date().toISOString() };
    const a = await boot(true, { ...WSL, windowsLink: { ...link, ok: false, error: 'Unable to connect to the remote server' } });
    const m = await onlineWith(a, (x) => x.resources?.windowsLink !== undefined);
    expect(m.resources?.windowsLink).toMatchObject({ ok: false, mode: 'nat' });
    await a.user().machineHistory.record();
    const broken = await waitFor(async () => (await a.events('types=machine.windows_link_broken'))[0]);
    expect(broken.data).toEqual({ machineId: 'laptop', url: link.url, mode: 'nat', error: 'Unable to connect to the remote server' });

    // Told once: a second record of the same broken link tells nothing more (working again: test/machines/windows-link-watch.test.ts).
    await a.user().machineHistory.record();
    expect(await a.events('types=machine.windows_link_broken')).toHaveLength(1);
  });
});

