// MachineSource adapters: `local`, this machine (reached through the `local` machine-source plugin),
// the attached machines (ssh targets and container targets), and the ssh targets ~/.ssh/config names.
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

export { createAttachedMachineSource, createAttachedMachines, probeContainer, knownHostKey, probeHerdrOverSsh, resolveSshTarget } from './attached.ts';
export { readSshTargets, type SshTargets } from './ssh-config.ts';

/** Every machine of every source, in source order: this machine first, then the attached ones. */
export function combineMachineSources(sources: MachineSource[]): MachineSource {
  return { list: async () => (await Promise.all(sources.map((s) => s.list()))).flat() };
}
