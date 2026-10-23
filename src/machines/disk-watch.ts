// The disk watch (issue #2494, design.md "A machine's disk"): at each record of the resource recorder it is shown every
// machine. A machine whose disk turns low is told once (`machine.disk_low`), told again when it turns critical, and once
// more when it is no longer low (`machine.disk_ok`), as the memory alert tells low memory. The guard itself is the
// decider's (a low machine takes no new job, a critical one no job at all), and the sweep frees what it may there at once
// (sweep-due.ts); this tells a person. It starts from what the event log last told of each machine, so a restart of the
// hopper tells nothing twice. A machine offline or with no reading keeps its state until a reading says otherwise.
import type { MachineSnapshot } from '../domain/types.ts';

/** How low a machine's disk was told: low, or critical. */
export type DiskLevel = 'low' | 'critical';

type Reading = { machineId: string; label: string; freeBytes: number; totalBytes: number };
export type DiskEvent =
  | { type: 'machine.disk_low'; machineId: string; data: Reading & { critical: boolean } }
  | { type: 'machine.disk_ok'; machineId: string; data: Reading };

export interface DiskWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

const levelOf = (d: NonNullable<MachineSnapshot['disk']>): DiskLevel | undefined => (d.critical ? 'critical' : d.low ? 'low' : undefined);

/** `told`: what the event log last told of each machine still told low, read once, at the first observe. */
export function createDiskWatch(o: { told: () => Iterable<readonly [string, DiskLevel]>; tell: (e: DiskEvent) => void }): DiskWatch {
  let told: Map<string, DiskLevel> | undefined;
  return {
    observe(machines) {
      told ??= new Map(o.told());
      for (const m of machines) {
        const d = m.online ? m.disk : undefined;
        if (!d) continue;
        const reading = { machineId: m.id, label: m.label, freeBytes: d.freeBytes, totalBytes: d.totalBytes };
        const was = told.get(m.id), now = levelOf(d);
        if (!now) {
          if (was && told.delete(m.id)) o.tell({ type: 'machine.disk_ok', machineId: m.id, data: reading });
          continue;
        }
        if (was === now || was === 'critical') continue;
        told.set(m.id, now);
        o.tell({ type: 'machine.disk_low', machineId: m.id, data: { ...reading, critical: now === 'critical' } });
      }
    },
  };
}

/** What the events say was last told of each machine (newest first, as the event log reads them): the machines still told low. */
export function toldOf(events: readonly { type: string; machineId?: string; data: unknown }[]): Array<[string, DiskLevel]> {
  const seen = new Set<string>(), out: Array<[string, DiskLevel]> = [];
  for (const e of events) {
    if (!e.machineId || seen.has(e.machineId)) continue;
    seen.add(e.machineId);
    if (e.type === 'machine.disk_low') out.push([e.machineId, (e.data as { critical?: boolean }).critical ? 'critical' : 'low']);
  }
  return out;
}
