// The resource graph's model (issue #560): a machine's lines — CPU, memory, swap, disk and its lanes in use —
// one colour each, on the Machines view; every machine's lines at once on the Usage page, one colour per machine
// and a dash per resource, swap and lanes hidden until shown; a machine row's CPU sparkline; and the resource
// facts its card says now. Pure.
import { describe, expect, it } from 'vitest';
import type { ResourceSeries } from '../../src/domain/types.ts';
import { allMachineLines, machineLines, resourcesText, sparkValues } from '../../ui/src/model/machine-history.ts';

const GIB = 1e9;
const at = (h: number) => new Date(Date.parse('2026-10-08T00:00:00.000Z') + h * 3_600_000).toISOString();
const series = (machineId: string, resource: ResourceSeries['resource'], ...v: number[]): ResourceSeries =>
  ({ machineId, resource, points: v.map((usedFrac, i) => ({ at: at(i), usedFrac })), gaps: [] });

const ALL = ['cpu', 'memory', 'swap', 'disk', 'lanes'] as const;

describe('a machine\'s resource graph', () => {
  it('one line per resource, each its own colour, named by the resource; swap and lanes shown too', () => {
    const lines = machineLines(ALL.map((r) => series('desk', r, 0.1)));
    expect(lines.map((l) => l.label)).toEqual(['CPU', 'memory', 'swap', 'disk', 'lanes in use']);
    expect(new Set(lines.map((l) => l.color)).size).toBe(5);
    expect(lines.every((l) => l.shownByDefault)).toBe(true);
    expect(lines.find((l) => l.label === 'lanes in use')!.dash).toBe('dashed');
    expect(lines[0]!.series.points).toEqual([{ at: at(0), usedFrac: 0.1 }]);
  });
});

describe('every machine\'s resources, on the Usage page', () => {
  it('one colour per machine, CPU solid, memory dashed, disk dotted; swap and lanes hidden until shown; named by the machine\'s label', () => {
    const lines = allMachineLines([...ALL.map((r) => series('desk', r, 0.2)), ...ALL.map((r) => series('box', r, 0.3))], (id) => (id === 'desk' ? 'Desk PC' : id));
    expect(lines.find((l) => l.key === 'desk|cpu')).toMatchObject({ label: 'Desk PC · CPU', dash: 'solid', shownByDefault: true });
    expect(lines.find((l) => l.key === 'desk|memory')).toMatchObject({ dash: 'dashed', shownByDefault: true });
    expect(lines.find((l) => l.key === 'desk|disk')).toMatchObject({ dash: 'dotted', shownByDefault: true });
    expect(lines.find((l) => l.key === 'desk|swap')!.shownByDefault).toBe(false);
    expect(lines.find((l) => l.key === 'box|lanes')!.shownByDefault).toBe(false);
    const colours = (id: string) => new Set(lines.filter((l) => l.key.startsWith(`${id}|`)).map((l) => l.color));
    expect(colours('desk').size).toBe(1);
    expect(colours('box').size).toBe(1);
    expect([...colours('desk')][0]).not.toBe([...colours('box')][0]);
  });
});

describe('a machine row', () => {
  it('its sparkline is its CPU over the range; no CPU line, none', () => {
    const s = [series('desk', 'cpu', 0.1, 0.5, 0.2), series('desk', 'memory', 0.9), series('box', 'cpu', 0.7)];
    expect(sparkValues(s, 'desk')).toEqual([0.1, 0.5, 0.2]);
    expect(sparkValues(s, 'nowhere')).toEqual([]);
  });

  it('says CPU busy, load, cores, memory and swap as people read them; a container says so', () => {
    expect(resourcesText({ cores: 8, cpuBusyFrac: 0.234, load: [2.5, 1, 0.5], memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB, swapTotalBytes: 8 * GIB, swapUsedBytes: 1 * GIB }))
      .toEqual({ cpu: '23% busy · load 2.50 1.00 0.50 · 8 cores', memory: '12 GB used of 16 GB (75%) · swap 1.0 GB of 8.0 GB' });
    expect(resourcesText({ cores: 1.5, memTotalBytes: 4 * GIB, memAvailableBytes: 3 * GIB, container: true }))
      .toEqual({ cpu: '1.5 cores (container limit)', memory: '1.0 GB used of 4.0 GB (25%, container limit)' });
    expect(resourcesText(undefined)).toBeNull();
  });
});
