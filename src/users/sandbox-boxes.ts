// A user's client targets, as the sandbox module runs a need step, a read-only check or a burn on one (issue #708).
import { runtimeRelay } from '../executors/client.ts';
import type { ClientTargets } from '../sandbox/runtime.ts';
import type { UserMachineLink } from './runtime.ts';

type Runtime = { user: { id: string }; machineLink: Pick<UserMachineLink, 'client'> };

/**
 * A user's client target by name (issue #708): its runtime calls go through its client. And the names of those dialled
 * in now, where a read-only check can run; and every user's, where the sweeps burn what a box left; and whether one is
 * there at all, dialled in or not (issue #1349).
 */
export const sandboxClientsOf = (runtimes: { get(id: string): Runtime | undefined; all(): Runtime[] }): ClientTargets => Object.assign(
  (userId: string, machine: string) => {
    const t = runtimes.get(userId)?.machineLink.client.named(machine);
    return t && { relay: runtimeRelay(t) };
  },
  {
    dialledIn: (userId: string) => runtimes.get(userId)?.machineLink.client.dialledIn() ?? [],
    allDialledIn: () => runtimes.all().flatMap((rt) => rt.machineLink.client.dialledIn().map((machine) => ({ userId: rt.user.id, machine }))),
    known: (userId: string, machine: string) => runtimes.get(userId)?.machineLink.client.named(machine) !== undefined,
  },
);
