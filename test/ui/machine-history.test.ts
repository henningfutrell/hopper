// The resource graph's model (issue #560): a machine's lines — CPU, memory, swap, disk and its lanes in use —
// one colour each, on the Machines view; every machine's lines at once on the Usage page, one colour per machine
// and a dash per resource, swap and lanes hidden until shown; a machine row's CPU sparkline; and the resource
// facts its card says now; on one machine's graph, the usage that limits it and its lane changes (issue #688). Pure.
import { describe, expect, it } from 'vitest';
import type { LaneChange, ResourceSeries, UsageSeries } from '../../src/domain/types.ts';
import { allMachineLines, jobsUseText, machineLines, resourcesText, sparkValues } from '../../ui/src/model/machine-history.ts';

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

describe('lanes and usage on a machine\'s graph (issue #688)', () => {
  const usage = (window: string, informational = false): UsageSeries =>
    ({ account: 'claude', window, informational, unit: '%', points: [{ at: at(0), usedFrac: 0.4 }], gaps: [], resets: [at(1)] });

  it('after the resources, a line per usage window that limits it, in one colour of its own: a week dashed, an informational one dotted and hidden', () => {
    const lines = machineLines(ALL.map((r) => series('desk', r, 0.1)), [usage('session'), usage('week'), usage('week (Fable)', true)]);
    expect(lines.map((l) => l.label)).toEqual(['CPU', 'memory', 'swap', 'disk', 'lanes in use', 'usage · claude · session', 'usage · claude · week', 'usage · claude · week (Fable)']);
    const used = lines.slice(5);
    expect(new Set(used.map((l) => l.key)).size).toBe(3);
    expect(new Set(used.map((l) => l.color)).size).toBe(1);
    expect(lines.slice(0, 5).map((l) => l.color)).not.toContain(used[0]!.color);
    expect(used.map((l) => l.dash)).toEqual(['solid', 'dashed', 'dotted']);
    expect(used.map((l) => l.shownByDefault)).toEqual([true, true, false]);
    expect(used[0]!.series.resets).toEqual([at(1)]);
  });

  it('each lane change is a mark on the lanes in use line, as people read it; no lanes line, no marks', () => {
    const changes: LaneChange[] = [
      { at: at(1), machineId: 'desk', from: 2, to: 4, kind: 'applied', reason: '4 lanes run without pressure', by: 'admin' },
      { at: at(2), machineId: 'desk', from: 4, to: 2, kind: 'undone', by: 'admin' },
      { at: at(3), machineId: 'desk', from: 1, to: 2, kind: 'applied', reason: 'room for 1 more' },
    ];
    const lines = machineLines(ALL.map((r) => series('desk', r, 0.1)), [], changes);
    expect(lines.find((l) => l.key === 'lanes')!.marks).toEqual([
      { at: at(1), label: 'Applied: 2 → 4 lanes, by admin. 4 lanes run without pressure' },
      { at: at(2), label: 'Undone: 4 → 2 lanes, by admin' },
      { at: at(3), label: 'Applied: 1 → 2 lanes. room for 1 more' },
    ]);
    expect(lines.filter((l) => l.marks !== undefined).map((l) => l.key)).toEqual(['lanes']);
    expect(machineLines([series('desk', 'cpu', 0.1)], [], changes).some((l) => l.marks !== undefined)).toBe(false);
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

  it('a WSL machine (issue #868) says the memory its VM holds and Windows\' free memory', () => {
    const r = { cores: 8, memTotalBytes: 20 * GIB, memAvailableBytes: 13 * GIB, wsl: true as const, vmHeldBytes: 19 * GIB };
    expect(resourcesText({ ...r, hostMemFreeBytes: 3 * GIB, hostMemTotalBytes: 32 * GIB })!.memory)
      .toBe('7.0 GB used of 20 GB (35%) · VM holds 19 GB · Windows 3.0 GB free of 32 GB');
    expect(resourcesText(r)!.memory).toBe('7.0 GB used of 20 GB (35%) · VM holds 19 GB');
  });

  // Issue #2498: what the hopper's own jobs use there now, beside the machine's whole use.
  it('a machine\'s jobs: their memory now, their CPU cores busy and their OOM kills, all its job scopes together', () => {
    const r = { cores: 8, memTotalBytes: 16 * GIB, memAvailableBytes: 4 * GIB };
    expect(jobsUseText({ ...r, jobMemoryBytes: { j1: 2 * GIB, j2: 1.5 * GIB }, jobUse: { j1: { cpuCores: 1.25, oomKills: 1 }, j2: { cpuCores: 0.5, oomKills: 0 } } }))
      .toBe('2 jobs use 3.5 GB · 1.8 cores busy · 1 OOM kill');
    expect(jobsUseText({ ...r, jobMemoryBytes: { j1: 2 * GIB } })).toBe('1 job uses 2.0 GB');
    expect(jobsUseText(r)).toBeNull();
    expect(jobsUseText(undefined)).toBeNull();
  });

  it('memory held and host memory are named lines', () => {
    expect(machineLines([series('win', 'held', 0.9), series('win', 'host', 0.8)]).map((l) => l.label)).toEqual(['memory held', 'host memory']);
  });

  // Issue #2499: the signals admission reads, as the card says them now.
  it('says memory pressure, CPU throttle and the last OOM kill', () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const r = { cores: 4, memTotalBytes: 4 * GIB, memAvailableBytes: 1 * GIB, container: true as const,
      memPressure: { someAvg10: 23.4, fullAvg10: 2 }, cpuThrottledFrac: 0.62, memOomKillAt: '2026-10-22T11:57:00.000Z' };
    expect(resourcesText(r, now)).toEqual({
      cpu: '4 cores (container limit) · throttled in 62% of its periods',
      memory: '3.0 GB used of 4.0 GB (75%, container limit) · pressure 23% · last OOM kill 3m ago',
    });
  });

  it('memory pressure and CPU throttle are named lines', () => {
    expect(machineLines([series('a', 'pressure', 0.2), series('a', 'throttle', 0.5)]).map((l) => l.label)).toEqual(['memory pressure', 'CPU throttle']);
  });

  // Issue #2494: the hopper's own disk use and the caches, each a share of the disk.
  it('the hopper\'s disk and the caches are named lines, hidden at first on the Usage page', () => {
    expect(machineLines([series('a', 'hopper', 0.2), series('a', 'caches', 0.1)]).map((l) => l.label)).toEqual(['hopper\'s disk', 'caches']);
    expect(allMachineLines([series('a', 'hopper', 0.2), series('a', 'caches', 0.1)], (id) => id).map((l) => l.shownByDefault)).toEqual([false, false]);
  });
});
