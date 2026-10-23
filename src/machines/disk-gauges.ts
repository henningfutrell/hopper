// The disk gauges (issue #2494, design.md "Hopper's own disk use" → "Part 12"): at each collection, what the hopper's own
// places, each cache kind and each kind of container storage take on the machines online, from each one's last disk
// measure (at most an hour old), and how many machines are online with a disk ok, low or critical. The resource recorder
// shows it the machines at each record. Enums only (src/telemetry/live.ts): no machine id, label or path goes out.
import { cacheUseOf, freshMeasure, type DiskMeasure, type MachineSnapshot } from '../domain/types.ts';
import { liveReader, type LivePoint } from '../telemetry/live.ts';

export interface DiskGauges {
  /** The machines now, at each record of the resource recorder. */
  observe(machines: readonly MachineSnapshot[]): void;
  start(): void;
  stop(): void;
}

const DISK_STATES = ['ok', 'low', 'critical'] as const;

/** The gauges' points for `machines` and their measures, at `at` (ISO). Pure. */
export function diskGaugePoints(machines: readonly MachineSnapshot[], measures: Iterable<readonly [string, DiskMeasure]>, at: string): { bytes: LivePoint[]; machines: LivePoint[] } {
  const online = machines.filter((m) => m.online);
  const byId = new Map(measures);
  const sums = new Map<string, number>();
  const add = (kind: string, bytes: number) => { sums.set(kind, (sums.get(kind) ?? 0) + bytes); };
  for (const m of online) {
    const fresh = freshMeasure(byId.get(m.id), at);
    if (!fresh) continue;
    add('hopper', fresh.paths.reduce((n, p) => n + p.bytes, 0));
    for (const c of cacheUseOf(fresh.caches ?? [])) add(c.kind, c.bytes);
    for (const s of fresh.storage ?? []) add(s.kind, s.bytes);
  }
  const states = new Map<string, number>();
  for (const m of online) {
    if (!m.disk) continue;
    const state = m.disk.critical ? 'critical' : m.disk.low ? 'low' : 'ok';
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return {
    bytes: [...sums].map(([kind, value]) => ({ value, attributes: { 'hopper.disk.kind': kind } })),
    machines: DISK_STATES.flatMap((state) => (states.has(state) ? [{ value: states.get(state)!, attributes: { 'hopper.disk.state': state } }] : [])),
  };
}

export function createDiskGauges(o: { measures: () => Array<[string, DiskMeasure]>; clock: { now(): Date } }): DiskGauges {
  let machines: readonly MachineSnapshot[] = [];
  const read = () => diskGaugePoints(machines, o.measures(), o.clock.now().toISOString());
  let drops: Array<() => void> = [];
  return {
    observe(now) { machines = now; },
    start() {
      if (drops.length) return;
      drops = [liveReader('hopper.disk.bytes', () => read().bytes), liveReader('hopper.machines.disk', () => read().machines)];
    },
    stop() {
      for (const d of drops) d();
      drops = [];
    },
  };
}
