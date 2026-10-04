import { hostname } from 'node:os';
import type { MachineSource } from '../domain/ports.ts';

export function createLocalMachineSource(o: {
  maxLanes: number;
  executors: string[];
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
        executors: [...o.executors],
      },
    ],
  };
}

export { createAttachedMachineSource, probeHerdrOverSsh } from './attached.ts';

/** Every machine of every source, in source order: this machine first, then the attached ones. */
export function combineMachineSources(sources: MachineSource[]): MachineSource {
  return { list: async () => (await Promise.all(sources.map((s) => s.list()))).flat() };
}
