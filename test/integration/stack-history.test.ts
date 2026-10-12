// The stack's resources over time (issue #947) through the real daemon, store and HTTP server: the stack recorder keeps,
// each minute, a stack sample per service and metric — each container's CPU and memory as shares of what it may use,
// Postgres's connections against the most it allows, OpenFGA's failed checks since the record before —; GET
// /api/resources/history answers them per graph step, with gaps; samples past the stack history retention are pruned.
// The container and OpenFGA meters are the seams; Postgres is the real one.
//
// Feature: the stack's resources over time
//   Scenario: each record keeps every running container's CPU and memory as shares, Postgres's connections, and OpenFGA's failed checks
//   Scenario: per graph step the peak; a stretch with no sample is a gap; a sample at the same time is kept once
//   Scenario: samples past the stack history retention are pruned
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerReading, OpenFgaReading, StackHistory, StackSample } from '../../src/domain/types.ts';
import { STACK_HISTORY_RETENTION_DAYS } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CONTAINERS: ContainerReading[] = [
  // A CPU quota and a memory limit: shares of those.
  { service: 'postgres', group: 'stack', name: 'hopper-postgres-1', image: 'postgres:17-alpine', state: 'running', cpuCores: 0.5, cpuLimitCores: 2, cores: 8, memUsedBytes: 512 * MiB, memLimitBytes: 2 * GiB, memMaxBytes: 2 * GiB },
  // No limits: shares of the cores and the memory it sees.
  { service: 'hopper', group: 'stack', name: 'hopper-hopper-1', image: 'hopper:1', state: 'running', cpuCores: 1, cores: 8, memUsedBytes: 1 * GiB, memMaxBytes: 16 * GiB },
  // Not running: nothing.
  { service: 'kms', group: 'stack', name: 'hopper-kms-1', image: 'local-kms', state: 'exited', restarts: 0 },
  { service: 'hopper-sandbox-claude', group: 'sandbox', name: 'hopper-sandbox-claude', image: 'box:1', state: 'running', cpuCores: 0.3, cpuLimitCores: 1.5 },
];

async function boot(openfga?: { now: OpenFgaReading }): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({
    dbPath: db.dbPath,
    seams: { containerMeter: { read: async () => ({ containers: CONTAINERS }) }, ...(openfga ? { openFgaMeter: { read: async () => openfga.now } } : {}) },
  });
  apps.push(a);
  return a;
}

const history = async (a: TestApp, query: string) => a.api<StackHistory>('GET', `/api/resources/history?${query}`);
const lastOf = (h: StackHistory, service: string, metric: string) => h.series.find((s) => s.service === service && s.metric === metric)?.points.at(-1)?.usedFrac;
const sample = (at: number, value: number, over: Partial<StackSample> = {}): StackSample =>
  ({ at: new Date(at).toISOString(), service: 'postgres', group: 'stack', metric: 'cpu', value, ...over });

describe('the stack\'s resources over time', () => {
  it('each record keeps every running container\'s CPU and memory as shares, Postgres\'s connections, and OpenFGA\'s failed checks', async () => {
    const openfga = { now: { checks: 100, errors: 3, meanMs: 1 } as OpenFgaReading };
    const a = await boot(openfga);
    // The first record: OpenFGA has no record before to count from.
    expect(await a.app.stackHistory.record()).toBe(6);
    openfga.now = { checks: 150, errors: 8, meanMs: 1 };
    expect(await a.app.stackHistory.record()).toBe(7);

    const r = await history(a, 'range=24h');
    expect(r.status).toBe(200);
    expect(r.body.view).toEqual({ range: { preset: '24h' } });
    expect(r.body.retentionDays).toBe(STACK_HISTORY_RETENTION_DAYS);
    expect(lastOf(r.body, 'postgres', 'cpu')).toBeCloseTo(0.25);
    expect(lastOf(r.body, 'postgres', 'memory')).toBeCloseTo(0.25);
    expect(lastOf(r.body, 'hopper', 'cpu')).toBeCloseTo(0.125);
    expect(lastOf(r.body, 'hopper', 'memory')).toBeCloseTo(1 / 16);
    expect(lastOf(r.body, 'hopper-sandbox-claude', 'cpu')).toBeCloseTo(0.2);
    expect(r.body.series.find((s) => s.service === 'hopper-sandbox-claude')!.group).toBe('sandbox');
    expect(r.body.series.some((s) => s.service === 'kms')).toBe(false);
    // 5 failed of the 50 checks since the record before.
    expect(lastOf(r.body, 'openfga', 'check-errors')).toBeCloseTo(0.1);
    const connections = lastOf(r.body, 'postgres', 'connections')!;
    expect(connections).toBeGreaterThan(0);
    expect(connections).toBeLessThanOrEqual(1);
  });

  it('OpenFGA restarted (fewer checks than before): no failed-check share from that record', async () => {
    const openfga = { now: { checks: 100, errors: 3 } as OpenFgaReading };
    const a = await boot(openfga);
    await a.app.stackHistory.record();
    openfga.now = { checks: 10, errors: 1 };
    await a.app.stackHistory.record();
    expect((await history(a, 'range=24h')).body.series.some((s) => s.metric === 'check-errors')).toBe(false);
  });

  it('per graph step the peak; a stretch with no sample is a gap; a sample at the same time is kept once', async () => {
    const a = await boot();
    const to = Date.parse('2026-10-08T12:00:00.000Z');
    const t0 = to - 6 * HOUR;
    const kept = a.app.instance.stackHistory.record([
      sample(t0, 0.1), sample(t0 + MIN, 0.6), sample(t0 + 2 * MIN, 0.2),
      // Postgres's container away for two hours.
      sample(t0 + 2 * HOUR, 0.3), sample(t0 + 2 * HOUR + MIN, 0.4),
      sample(t0, 0.5, { service: 'openfga', metric: 'memory' }),
    ]);
    expect(kept).toBe(6);
    expect(a.app.instance.stackHistory.record([sample(t0, 0.9)])).toBe(0);
    const r = await history(a, `from=${new Date(t0).toISOString()}&to=${new Date(to).toISOString()}`);
    expect(r.status).toBe(200);
    expect(r.body.stepMs).toBe(15 * MIN);
    const cpu = r.body.series.find((s) => s.service === 'postgres' && s.metric === 'cpu')!;
    expect(cpu.points.map((p) => p.usedFrac)).toEqual([0.6, 0.4]);
    expect(cpu.gaps).toEqual([{ from: new Date(t0 + 2 * MIN).toISOString(), to: new Date(t0 + 2 * HOUR).toISOString() }]);
    expect(r.body.series.find((s) => s.service === 'openfga')!.points.map((p) => p.usedFrac)).toEqual([0.5]);
    expect((await history(a, 'range=2y')).status).toBe(400);
  });

  it('samples past the stack history retention are pruned', async () => {
    const a = await boot();
    const now = Date.now();
    a.app.instance.stackHistory.record([sample(now - (STACK_HISTORY_RETENTION_DAYS + 5) * DAY, 0.1), sample(now - 2 * DAY, 0.2)]);
    expect(a.app.stackHistory.prune()).toBe(1);
    const cpu = (await history(a, 'range=30d')).body.series.find((s) => s.service === 'postgres' && s.metric === 'cpu')!.points.map((p) => p.usedFrac);
    expect(cpu).toContain(0.2);
    expect(cpu).not.toContain(0.1);
  });
});
