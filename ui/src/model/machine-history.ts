// The resource graph's model (issue #560, design.md "Machine resources over time"): a machine's lines — CPU, memory,
// a WSL machine's memory held and host memory (issue #868), swap, disk, its lanes in use, memory pressure and CPU throttle (issue #2499),
// the hopper's own disk use and the caches (issue #2494), one colour each — drawn by the usage graph (charts/usage-history.tsx) on the
// Machines view; every machine's lines at once on the Usage page, one colour per machine and a dash per resource,
// swap and lanes hidden until shown; a machine row's CPU sparkline; the resource facts a machine card says now; and a lane's memory (issue #2722).
// One machine's graph overlays the usage that limits it and marks its lane changes on its lanes in use (issue #688).
// Pure: tested from test/ui/machine-history.test.ts.
import type { LaneChange, MachineResource, ResourceReading, ResourceSeries, UsageSeries } from '../../../src/domain/types.ts';
import { ago } from './format.ts';
import { gb } from './machines.ts';
import { ACCOUNT_COLORS, graphLines, type GraphLine, type GraphMark, type LineDash } from './usage-history.ts';

export const RESOURCE_NAMES: Readonly<Record<MachineResource, string>> = {
  cpu: 'CPU', memory: 'memory', held: 'memory held', host: 'host memory', swap: 'swap', disk: 'disk', lanes: 'lanes in use',
  pressure: 'memory pressure', throttle: 'CPU throttle', hopper: 'hopper\'s disk', caches: 'caches',
};
/** Memory held (a WSL VM's, issue #868) is memory's colour, dashed; host memory (Windows') the brand's. */
const RESOURCE_COLORS: Readonly<Record<MachineResource, string>> = {
  cpu: 'var(--busy)', memory: 'var(--ok)', held: 'var(--ok)', host: 'var(--brand)', swap: 'var(--question)', disk: 'var(--warn)', lanes: 'var(--operator)',
  pressure: 'var(--bad)', throttle: 'var(--busy)', hopper: 'var(--brand)', caches: 'var(--question)',
};
/** The hopper's disk and the caches (issue #2494) are dashed: parts of the disk line. */
const DASHED_ON_MACHINE: ReadonlySet<MachineResource> = new Set(['held', 'lanes', 'hopper', 'caches']);
/** Memory pressure and CPU throttle (issue #2499) are dotted: the signals admission reads, not a share used. */
const DOTTED_ON_MACHINE: ReadonlySet<MachineResource> = new Set(['pressure', 'throttle']);
/** On the Usage page, where colour is the machine's: CPU solid, memory and host memory dashed, disk dotted (swap, memory held and lanes, hidden at first, likewise). */
const RESOURCE_DASH: Readonly<Record<MachineResource, LineDash>> = {
  cpu: 'solid', memory: 'dashed', held: 'dotted', host: 'dashed', swap: 'dotted', disk: 'dotted', lanes: 'dashed', pressure: 'dotted', throttle: 'dotted', hopper: 'dashed', caches: 'dotted',
};
const HIDDEN_ON_USAGE: ReadonlySet<MachineResource> = new Set(['swap', 'held', 'lanes', 'pressure', 'throttle', 'hopper', 'caches']);

/** A resource line as the usage graph draws one: its points are shares, 0..1, as a usage window's are. */
const asUsage = (s: ResourceSeries, account: string, window?: string): UsageSeries =>
  ({ account, ...(window !== undefined ? { window } : {}), informational: false, unit: '%', points: s.points, gaps: s.gaps, resets: [] });

/** The usage lines' one colour on a machine's graph: none of its resources' colours. */
const USAGE_COLOR = 'var(--bad)';

const lanesText = (n: number): string => `${n} lane${n === 1 ? '' : 's'}`;

/** A lane change as its mark on the graph reads. */
const markOf = (c: LaneChange): GraphMark => {
  const what = `${c.kind === 'applied' ? 'Applied' : 'Undone'}: ${c.from} → ${lanesText(c.to)}${c.by ? `, by ${c.by}` : ''}`;
  return { at: c.at, label: c.kind === 'applied' && c.reason ? `${what}. ${c.reason}` : what };
};

/**
 * One machine's lines, in the order CPU, memory, swap, disk, lanes in use — its lane changes marked on that line —,
 * then a line per usage window that limits it, in one colour, dashed and shown as on the usage graph.
 */
export function machineLines(series: readonly ResourceSeries[], usage: readonly UsageSeries[] = [], changes: readonly LaneChange[] = []): GraphLine[] {
  const resources: GraphLine[] = series.map((s) => ({
    key: s.resource, label: RESOURCE_NAMES[s.resource], color: RESOURCE_COLORS[s.resource],
    dash: DASHED_ON_MACHINE.has(s.resource) ? 'dashed' : DOTTED_ON_MACHINE.has(s.resource) ? 'dotted' : 'solid',
    shownByDefault: true, series: asUsage(s, RESOURCE_NAMES[s.resource]),
    ...(s.resource === 'lanes' && changes.length ? { marks: changes.map(markOf) } : {}),
  }));
  const used = graphLines(usage).map((l) => ({ ...l, key: `usage|${l.key}`, label: `usage · ${l.label}`, color: USAGE_COLOR }));
  return [...resources, ...used];
}

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

/**
 * What a machine card says of its CPU and memory now; null when they were not read. Issue #2499: with the signals
 * admission reads — its CPU throttle, its memory pressure and its last OOM kill, `now` the time to say it from.
 */
export function resourcesText(r: ResourceReading | undefined, now = Date.now()): { cpu: string; memory: string } | null {
  if (!r) return null;
  const limit = r.container ? ' (container limit)' : '';
  const cpu = [
    ...(r.cpuBusyFrac !== undefined ? [`${pct(r.cpuBusyFrac)} busy`] : []),
    ...(r.load ? [`load ${r.load.map((l) => l.toFixed(2)).join(' ')}`] : []),
    `${coresText(r.cores)}${limit}`,
    ...(r.cpuThrottledFrac ? [`throttled in ${pct(r.cpuThrottledFrac)} of its periods`] : []),
  ].join(' · ');
  const used = r.memTotalBytes - r.memAvailableBytes;
  const share = r.memTotalBytes > 0 ? pct(used / r.memTotalBytes) : '—';
  const swap = r.swapTotalBytes ? ` · swap ${gb(r.swapUsedBytes ?? 0)} of ${gb(r.swapTotalBytes)}` : '';
  // A WSL machine (issue #868): its VM keeps the page cache, so it holds more than it uses; Windows' free memory is what runs out.
  const held = r.vmHeldBytes !== undefined ? ` · VM holds ${gb(r.vmHeldBytes)}` : '';
  const host = r.hostMemFreeBytes !== undefined && r.hostMemTotalBytes !== undefined ? ` · Windows ${gb(r.hostMemFreeBytes)} free of ${gb(r.hostMemTotalBytes)}` : '';
  const pressure = r.memPressure ? ` · pressure ${Math.round(r.memPressure.someAvg10)}%` : '';
  const kill = r.memOomKillAt ? ` · last OOM kill ${ago(r.memOomKillAt, now)}` : '';
  // Issue #2622 part 6: the kernel's large page allocation failures (order 4 or more) in the last 10 minutes.
  const f = r.memAllocFailures;
  const fails = f ? ` · ${f.count} large allocation failure${f.count === 1 ? '' : 's'} (${f.count === 1 ? '' : 'up to '}order ${f.maxOrder}) in 10 min` : '';
  return { cpu, memory: `${gb(used)} used of ${gb(r.memTotalBytes)} (${share}${r.container ? ', container limit' : ''})${swap}${held}${host}${pressure}${kill}${fails}` };
}

/** What the hopper's jobs use on a machine now (issue #2498), all its job scopes together; null when none was read. */
export function jobsUseText(r: ResourceReading | undefined): string | null {
  const jobs = Object.keys(r?.jobMemoryBytes ?? {});
  if (!r || jobs.length === 0) return null;
  const memory = jobs.reduce((n, id) => n + (r.jobMemoryBytes?.[id] ?? 0), 0);
  const use = Object.values(r.jobUse ?? {});
  const cores = use.some((u) => u.cpuCores !== undefined) ? use.reduce((n, u) => n + (u.cpuCores ?? 0), 0) : undefined;
  const kills = use.reduce((n, u) => n + (u.oomKills ?? 0), 0);
  return [
    `${jobs.length} ${jobs.length === 1 ? 'job uses' : 'jobs use'} ${gb(memory)}`,
    ...(cores !== undefined ? [`${coresText(Math.round(cores * 10) / 10)} busy`] : []),
    ...(kills > 0 ? [`${kills} OOM ${kills === 1 ? 'kill' : 'kills'}`] : []),
  ].join(' · ');
}

/**
 * A lane's memory on the lane board (issue #2722): its job's scope's memory in use now and its peak, as its machine's
 * meter last read them (`jobMemoryBytes`, `jobUse`). Null when the meter did not read the job's scope.
 */
export function laneMemoryText(r: ResourceReading | undefined, jobId: string): { text: string; title: string } | null {
  const now = r?.jobMemoryBytes?.[jobId];
  if (now === undefined) return null;
  const peak = r?.jobUse?.[jobId]?.memoryPeakBytes;
  return peak === undefined
    ? { text: `memory ${gb(now)}`, title: `Its job uses ${gb(now)} of memory now` }
    : { text: `memory ${gb(now)} · peak ${gb(peak)}`, title: `Its job uses ${gb(now)} of memory now; its peak was ${gb(peak)}` };
}
