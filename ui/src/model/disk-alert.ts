// The header's disk alert (issue #2494, design.md "A machine's disk"): on every screen, the online machines whose disk is
// low, each with its free space, a link to Machines. Critical when one of them is: it takes no job at all.
import type { MachineSnapshot } from '../../../src/domain/types.ts';
import { gb } from './machines.ts';

export interface DiskAlert { n: number; critical: boolean; words: string; title: string }

type Machine = Pick<MachineSnapshot, 'id' | 'label' | 'online'> & { disk?: MachineSnapshot['disk'] };

/** The alert the machines raise; null while no online machine has a low disk. */
export function diskAlert(machines: readonly Machine[]): DiskAlert | null {
  const low = machines.filter((m) => m.online && m.disk?.low);
  if (low.length === 0) return null;
  const critical = low.some((m) => m.disk!.critical);
  const named = low.map((m) => `${m.label || m.id} (${gb(m.disk!.freeBytes)} free${m.disk!.critical ? ', critical' : ''})`).join(', ');
  return {
    n: low.length, critical,
    words: critical ? 'disk critical' : low.length === 1 ? 'disk low' : 'disks low',
    title: `Disk low: ${named}. A machine with a low disk takes no new job${critical ? '; a critical one takes no job at all' : ''}.`,
  };
}
