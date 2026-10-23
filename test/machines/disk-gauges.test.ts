// The disk gauges (issue #2494, design.md "Hopper's own disk use" → "Part 12"): at each collection, what the hopper's
// own use, each cache kind and each kind of container storage take on the machines online, from their last disk
// measure, and how many machines are online with a disk ok, low or critical. Enums only: no machine id or path goes out.
// Behaviour only: the pure points, and the gauges through an in-memory metric reader.
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiskMeasure, MachineSnapshot } from '../../src/domain/types.ts';
import { createDiskGauges, diskGaugePoints } from '../../src/machines/disk-gauges.ts';
import { observeLive } from '../../src/telemetry/live.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { machine } from '../decider/support.ts';

const GIB = 1024 ** 3;
const AT = '2026-10-23T12:00:00.000Z';

const disk = (free: number, over: Partial<NonNullable<MachineSnapshot['disk']>> = {}) => ({ disk: { freeBytes: free * GIB, totalBytes: 100 * GIB, low: false, ...over } });
const measure = (at = '2026-10-23T11:50:00.000Z'): DiskMeasure => ({
  at, paths: [{ path: '/w/.worktrees', bytes: 6 * GIB }],
  caches: [{ kind: 'cache', path: '/h/.cache', bytes: 3 * GIB }, { kind: 'pip', path: '/h/.cache/pip', bytes: GIB }, { kind: 'nuget', path: '/h/.nuget/packages', bytes: 2 * GIB }],
  storage: [{ runtime: 'podman', kind: 'images', bytes: 4 * GIB, reclaimableBytes: GIB }, { runtime: 'docker', kind: 'images', bytes: GIB, reclaimableBytes: 0 }],
});
const value = (points: { value: number; attributes: Record<string, string> }[], key: string, v: string): number =>
  points.filter((p) => p.attributes[key] === v).reduce((n, p) => n + p.value, 0);

describe('the disk gauge points (issue #2494)', () => {
  it('sums each kind over the machines online with a fresh measure; a cache inside ~/.cache is counted once', () => {
    const machines = [machine({ id: 'a', ...disk(50) }), machine({ id: 'b', ...disk(50) })];
    const p = diskGaugePoints(machines, [['a', measure()], ['b', measure()]], AT);
    expect(value(p.bytes, 'hopper.disk.kind', 'hopper')).toBe(12 * GIB);
    expect(value(p.bytes, 'hopper.disk.kind', 'cache')).toBe(4 * GIB);
    expect(value(p.bytes, 'hopper.disk.kind', 'pip')).toBe(2 * GIB);
    expect(value(p.bytes, 'hopper.disk.kind', 'nuget')).toBe(4 * GIB);
    expect(value(p.bytes, 'hopper.disk.kind', 'images')).toBe(10 * GIB);
  });

  it('leaves out a machine offline, one not there any more, and a measure more than an hour old', () => {
    const machines = [machine({ id: 'off', online: false }), machine({ id: 'old', ...disk(50) })];
    const p = diskGaugePoints(machines, [['off', measure()], ['gone', measure()], ['old', measure('2026-10-23T10:00:00.000Z')]], AT);
    expect(p.bytes).toEqual([]);
  });

  it('counts the machines online with a disk reading by its state', () => {
    const machines = [
      machine({ id: 'a', ...disk(50) }), machine({ id: 'b', ...disk(4, { low: true }) }), machine({ id: 'c', ...disk(1, { low: true, critical: true }) }),
      machine({ id: 'd', online: false, ...disk(1, { low: true }) }), machine({ id: 'e' }),
    ];
    const p = diskGaugePoints(machines.map((m) => (m.id === 'e' ? { ...m, disk: undefined } : m)), [], AT);
    expect(p.machines).toEqual([
      { value: 1, attributes: { 'hopper.disk.state': 'ok' } },
      { value: 1, attributes: { 'hopper.disk.state': 'low' } },
      { value: 1, attributes: { 'hopper.disk.state': 'critical' } },
    ]);
  });
});

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

describe('the disk gauges (issue #2494)', () => {
  let reader: TestReader;
  let telemetry: Telemetry;
  let stopLive: () => void;
  beforeEach(() => {
    reader = new TestReader();
    telemetry = startTelemetry({ env: {}, version: '0.0.0-test', metricReaders: [reader] });
    stopLive = observeLive();
  });
  afterEach(async () => {
    stopLive();
    await telemetry.shutdown();
  });
  const points = async (name: string) => {
    const rm: ResourceMetrics = (await reader.collect()).resourceMetrics;
    return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
  };

  it('report the machines the recorder last showed them, while started, with no machine id or path', async () => {
    const gauges = createDiskGauges({ measures: () => [['seat-secret-1', measure()]], clock: { now: () => new Date(AT) } });
    gauges.start();
    gauges.start(); // started twice, read once
    gauges.observe([machine({ id: 'seat-secret-1', label: 'label-secret', ...disk(4, { low: true }) })]);
    const bytes = await points('hopper.disk.bytes');
    expect(bytes.find((p) => p.attributes['hopper.disk.kind'] === 'hopper')?.value).toBe(6 * GIB);
    expect((await points('hopper.machines.disk')).find((p) => p.attributes['hopper.disk.state'] === 'low')?.value).toBe(1);
    const exported = JSON.stringify([...bytes, ...await points('hopper.machines.disk')].map((p) => p.attributes));
    for (const word of ['seat-secret', 'label-secret', '/w/', '/h/']) expect(exported).not.toContain(word);
    gauges.stop();
  });
});
