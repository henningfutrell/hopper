// What runs now (issue #1486, design.md "Telemetry: what runs now"): the sandboxes that run at the same time, the
// store's open connections, and the machines' disk use and state (issue #2494), read at each collection. The part that holds them adds a reader and drops it when it stops;
// telemetry off, no reader is read. Readers of the same gauge are summed by their attributes.
import { metrics, type BatchObservableResult } from '@opentelemetry/api';
import { SCOPE } from './instruments.ts';

/** One value of a gauge, with its attributes: enums only, never a name, an id or a value. */
export interface LivePoint { value: number; attributes: Record<string, string> }

const GAUGES = {
  'hopper.sandboxes': 'Sandboxes now, by kind (need, playground), place (local, machine) and state.',
  'hopper.db.connections': 'The store\'s open connections: one per open store.',
  'hopper.disk.bytes': 'What the machines online take on disk, by kind: the hopper\'s own places, each cache kind, each kind of container storage (issue #2494).',
  'hopper.machines.disk': 'The machines online with a disk reading, by its state: ok, low, critical (issue #2494).',
} as const;
export type LiveGauge = keyof typeof GAUGES;

const readers = new Map<LiveGauge, Set<() => LivePoint[]>>();

/** Adds `read` to the gauge; the returned function drops it. */
export function liveReader(gauge: LiveGauge, read: () => LivePoint[]): () => void {
  const set = readers.get(gauge) ?? new Set();
  readers.set(gauge, set);
  set.add(read);
  return () => { set.delete(read); };
}

/** Reports every gauge at each collection; the returned function stops it. Started after the SDK, as observeProcess. */
export function observeLive(): () => void {
  const meter = metrics.getMeterProvider().getMeter(SCOPE);
  const gauges = (Object.keys(GAUGES) as LiveGauge[]).map((name) => ({ name, it: meter.createObservableGauge(name, { description: GAUGES[name] }) }));
  const callback = (r: BatchObservableResult): void => {
    for (const g of gauges) {
      const sums = new Map<string, LivePoint>();
      for (const read of readers.get(g.name) ?? []) {
        let points: LivePoint[];
        try { points = read(); } catch { continue; } // a part that cannot answer now reports nothing this time
        for (const p of points) {
          const key = JSON.stringify(Object.entries(p.attributes).sort());
          const at = sums.get(key);
          sums.set(key, { value: (at?.value ?? 0) + p.value, attributes: p.attributes });
        }
      }
      for (const p of sums.values()) r.observe(g.it, p.value, p.attributes);
    }
  };
  const observables = gauges.map((g) => g.it);
  meter.addBatchObservableCallback(callback, observables);
  return () => { meter.removeBatchObservableCallback(callback, observables); };
}
