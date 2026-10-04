// MachineSource adapters: `local`, this machine. Reached through the `local` machine-source plugin.
import { hostname } from 'node:os';
import type { MachineSource } from '../domain/ports.ts';

export function createLocalMachineSource(o: {
  maxLanes: number;
  /** The executors registered now; asked on every list(). */
  executors: () => string[];
  id?: string;
  label?: string;
}): MachineSource {
  return {
    list: async () => [
      {
        id: o.id ?? 'local',
        label: o.label ?? hostname(),
        maxLanes: o.maxLanes,
        online: true,
        executors: [...o.executors()],
      },
    ],
  };
}
