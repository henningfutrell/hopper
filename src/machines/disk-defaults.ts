// The disk defaults applied to a machine (issue #2494, design.md "Hopper's own disk use" → "Part 13"), pure: each field the
// machine's own options leave out takes the user's default, a retention per status and a cache cap per kind each on its
// own; its disk is judged again by the thresholds that result. A container target takes none: its disk is not read and
// the sweep does not treat it.
import type { DiskDefaults } from '../domain/disk-defaults.ts';
import type { SweepSettings } from '../domain/machines.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { judged } from './disk.ts';

const merged = <T extends object>(d: T | undefined, own: T | undefined): T | undefined => (d || own ? { ...d, ...own } as T : undefined);

function sweepWith(d: SweepSettings | undefined, own: SweepSettings | undefined): SweepSettings | undefined {
  if (!d) return own;
  const retainHours = merged(d.retainHours, own?.retainHours), cacheCapsGiB = merged(d.cacheCapsGiB, own?.cacheCapsGiB);
  return { ...d, ...own, ...(retainHours ? { retainHours } : {}), ...(cacheCapsGiB ? { cacheCapsGiB } : {}) };
}

export function withDiskDefaults(m: MachineSnapshot, d: DiskDefaults | undefined): MachineSnapshot {
  if (!d || m.containerImage !== undefined) return m;
  const sweep = sweepWith(d.sweep, m.sweep);
  return { ...m, ...(sweep ? { sweep } : {}), ...(m.disk && d.diskLow ? { disk: judged(m.disk, merged(d.diskLow, m.diskThresholds)) } : {}) };
}
