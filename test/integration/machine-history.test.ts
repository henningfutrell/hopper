// Machine resources over time (issue #560) through the real daemon, store and HTTP server: a machine's probe
// carries its CPU, memory, swap and disk on its snapshot; the resource recorder keeps one machine sample per
// online machine with readings, with its lanes in use; an offline machine adds nothing, which the graph shows
// as a gap; GET /api/machines/:id/history and GET /api/machines/history answer the resource graph per graph
// step; new samples are pushed as machine.recorded; the history retention prunes them with the usage samples.
// The probe is the seam: no ssh here.
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineHistory, MachineSample, ResourceReading } from '../../src/domain/types.ts';
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
async function boot(online = true): Promise<TestApp & { probe: { now: MachineProbe } }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'test', plugin: 'test' }],
    machines: [{ name: 'laptop', plugin: 'ssh', options: { label: 'arch-laptop', ssh: 'laptop', lanes: 4, executors: ['test'] } }],
  });
  const probe = { now: (online ? { online: true, home: '/home/far', disk: { freeBytes: 25 * GIB, totalBytes: 100 * GIB, low: false }, resources: RES } : { online: false }) as MachineProbe };
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
