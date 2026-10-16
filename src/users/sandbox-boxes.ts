// A user's client targets, as the sandbox module runs a need step, a read-only check or a burn on one (issue #708).
import { runtimeRelay } from '../executors/client.ts';
import type { ClientTargets } from '../sandbox/runtime.ts';
import type { UserMachineLink } from './runtime.ts';

/**
 * A user's client target by name (issue #708): its runtime calls go through its client. And the names of those dialled
 * in now, where a read-only check can run.
 */
export const sandboxClientsOf = (runtimes: { get(id: string): { machineLink: Pick<UserMachineLink, 'client'> } | undefined }): ClientTargets => Object.assign(
  (userId: string, machine: string) => {
    const t = runtimes.get(userId)?.machineLink.client.named(machine);
    return t && { relay: runtimeRelay(t) };
  },
  { dialledIn: (userId: string) => runtimes.get(userId)?.machineLink.client.dialledIn() ?? [] },
);
