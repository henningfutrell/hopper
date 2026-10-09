// The resource graph's model (issue #560, design.md "Machine resources over time"): a machine's lines — CPU, memory,
// swap, disk and its lanes in use, one colour each — drawn by the usage graph (charts/usage-history.tsx) on the
// Machines view; every machine's lines at once on the Usage page, one colour per machine and a dash per resource,
// swap and lanes hidden until shown; a machine row's CPU sparkline; and the resource facts a machine card says now.
// Pure: tested from test/ui/machine-history.test.ts.
import type { MachineResource, ResourceReading, ResourceSeries, UsageSeries } from '../../../src/domain/types.ts';
import { gb } from './machines.ts';
import { ACCOUNT_COLORS, type GraphLine, type LineDash } from './usage-history.ts';

export const RESOURCE_NAMES: Readonly<Record<MachineResource, string>> = { cpu: 'CPU', memory: 'memory', swap: 'swap', disk: 'disk', lanes: 'lanes in use' };
const RESOURCE_COLORS: Readonly<Record<MachineResource, string>> = { cpu: 'var(--busy)', memory: 'var(--ok)', swap: 'var(--question)', disk: 'var(--warn)', lanes: 'var(--operator)' };
/** On the Usage page, where colour is the machine's: CPU solid, memory dashed, disk dotted (swap and lanes, hidden at first, likewise). */
const RESOURCE_DASH: Readonly<Record<MachineResource, LineDash>> = { cpu: 'solid', memory: 'dashed', swap: 'dotted', disk: 'dotted', lanes: 'dashed' };
const HIDDEN_ON_USAGE: ReadonlySet<MachineResource> = new Set(['swap', 'lanes']);

/** A resource line as the usage graph draws one: its points are shares, 0..1, as a usage window's are. */
const asUsage = (s: ResourceSeries, account: string, window?: string): UsageSeries =>
  ({ account, ...(window !== undefined ? { window } : {}), informational: false, unit: '%', points: s.points, gaps: s.gaps, resets: [] });

/** One machine's lines, in the order CPU, memory, swap, disk, lanes in use. */
export const machineLines = (series: readonly ResourceSeries[]): GraphLine[] => series.map((s) => ({
  key: s.resource, label: RESOURCE_NAMES[s.resource], color: RESOURCE_COLORS[s.resource], dash: s.resource === 'lanes' ? 'dashed' : 'solid',
  shownByDefault: true, series: asUsage(s, RESOURCE_NAMES[s.resource]),
}));

/** Every machine's lines, named `<machine label> · <resource>`; a colour per machine, in the order machines first appear. */
export function allMachineLines(series: readonly ResourceSeries[], labelOf: (machineId: string) => string): GraphLine[] {
  const colors = new Map<string, string>();
  return series.map((s) => {
    if (!colors.has(s.machineId)) colors.set(s.machineId, ACCOUNT_COLORS[colors.size % ACCOUNT_COLORS.length]!);
    const label = labelOf(s.machineId);
    return {
      key: `${s.machineId}|${s.resource}`, label: `${label} · ${RESOURCE_NAMES[s.resource]}`, color: colors.get(s.machineId)!,
      dash: RESOURCE_DASH[s.resource], shownByDefault: !HIDDEN_ON_USAGE.has(s.resource), series: asUsage(s, label, RESOURCE_NAMES[s.resource]),
    };
  });
}

/** A machine row's sparkline: its CPU per graph step over the range. */
export const sparkValues = (series: readonly ResourceSeries[], machineId: string): number[] =>
  series.find((s) => s.machineId === machineId && s.resource === 'cpu')?.points.map((p) => p.usedFrac) ?? [];

const pct = (f: number): string => `${Math.round(f * 100)}%`;
const coresText = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'core' : 'cores'}`;

/** What a machine card says of its CPU and memory now; null when they were not read. */
export function resourcesText(r: ResourceReading | undefined): { cpu: string; memory: string } | null {
  if (!r) return null;
  const limit = r.container ? ' (container limit)' : '';
  const cpu = [
    ...(r.cpuBusyFrac !== undefined ? [`${pct(r.cpuBusyFrac)} busy`] : []),
    ...(r.load ? [`load ${r.load.map((l) => l.toFixed(2)).join(' ')}`] : []),
    `${coresText(r.cores)}${limit}`,
  ].join(' · ');
  const used = r.memTotalBytes - r.memAvailableBytes;
  const share = r.memTotalBytes > 0 ? pct(used / r.memTotalBytes) : '—';
  const swap = r.swapTotalBytes ? ` · swap ${gb(r.swapUsedBytes ?? 0)} of ${gb(r.swapTotalBytes)}` : '';
  return { cpu, memory: `${gb(used)} used of ${gb(r.memTotalBytes)} (${share}${r.container ? ', container limit' : ''})${swap}` };
}
