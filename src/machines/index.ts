// MachineSource adapters: `local`, this machine (reached through the `local` machine-source plugin),
// the attached machines (ssh, container and client targets, reached through the target pool), and the
// ssh targets ~/.ssh/config names.
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

export { createAttachedMachineSource, createTargetPool, probeClient, probeContainer, knownHostKey, probeHerdrOverSsh, probeSsh, resolveSshTarget, type MachineProbe, type ResolvedTarget } from './attached.ts';
export { createClientReleaseKeeper, type ClientReleaseKeeper } from './client-release.ts';
export { readSshTargets, type SshTargets } from './ssh-config.ts';
