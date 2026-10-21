// The sandbox host (issue #2272, design.md "The sandbox host"): an admin names the machines the user's sandboxes start
// on, in priority order, or clears it. Kept in the user's settings (`sandboxHost`), so a restart keeps it, and read by the
// sandbox module at each sandbox it starts: a change needs no restart, and a sandbox that runs already ends where it
// started. Each machine the engine lists carries its place in it (`sandboxHost`).
import { sandboxHostProblem, withSandboxHost, type SandboxHost } from '../domain/sandbox-host.ts';
import type { MachineSource } from '../domain/ports.ts';
import type { ActingPerson } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What a set answers: the sandbox host now, first first; empty: none, sandboxes start where they did before. */
export interface SandboxHostOutcome { hosts: string[] }

export interface SandboxHostSetting {
  /** The sandbox host now; empty: none. */
  hosts(): string[];
  /** Name the sandbox host, first first, or clear it (`[]`); `by` names who and the way. A no-op records nothing. */
  set(hosts: readonly string[], by: ActingPerson): Promise<SandboxHostOutcome>;
}

/** The machines with each one of the sandbox host marked, read from the user's settings at each list. */
export const sandboxHostMachines = (machines: MachineSource, c: Pick<EngineContext, 'store'>): MachineSource => ({
  list: async () => withSandboxHost(await machines.list(), c.store.settings.getSandboxHost()?.hosts ?? []),
});

export function createSandboxHostSetting(c: EngineContext): SandboxHostSetting {
  const hosts = (): string[] => [...(c.store.settings.getSandboxHost()?.hosts ?? [])];
  return {
    hosts,
    async set(next, by) {
      const problem = sandboxHostProblem(next, await c.machines.list(), (id) => c.configuredMachines()?.includes(id) ?? false);
      if (problem) throw new EngineError(/not found/.test(problem) ? 'not_found' : 'invalid', problem);
      const was = hosts();
      if (was.join('\0') !== next.join('\0')) {
        const kept: SandboxHost = { hosts: [...next], ...by, at: c.clock.now().toISOString() };
        c.store.tx(() => {
          c.store.settings.setSandboxHost(kept);
          c.store.events.append({ type: 'machine.sandbox_host_set', data: { hosts: [...next], was, ...by } });
        });
        c.trigger(next.length ? `sandbox host ${next.join(', ')}` : 'sandbox host cleared');
      }
      return { hosts: [...next] };
    },
  };
}
