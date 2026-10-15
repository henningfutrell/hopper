// A machine leaving (design.md "Lane pods", issue #1284), `POST /client/leave`: the client target holding the machine
// key is leaving from now on (no new job is placed on it, src/decider/assign.ts `leavingHolds`), and the answer says how
// many jobs are still on it. A lane pod with none left is retired: removed from the plugins config, as a person removes
// a machine, so a pool scaled down leaves no machine behind. A pod that starts again joins again with the lane pool key,
// under its own name: the same machine. Any other machine only stops taking jobs until it dials in again.
import type { ConfigRecords } from '../domain/ports.ts';
import type { AttachedMachine } from '../domain/types.ts';
import type { PluginsEdit, PluginsEditOutcome } from '../domain/plugins.ts';
import type { MachineLinks } from '../machines/links.ts';
import { PLUGINS } from '../plugins/plugins-config.ts';

export interface MachineLeaveAnswer { jobs: number; retired: boolean }

export function machineLeave(o: {
  userId: string;
  links: Pick<MachineLinks, 'leave'>;
  targets: () => AttachedMachine[];
  /** The jobs that need the machine: busy lanes there, waiting panes there. */
  jobsOn: (name: string) => string[];
  config: Pick<ConfigRecords, 'version'>;
  edit: (e: PluginsEdit) => Promise<PluginsEditOutcome>;
}): (key: string) => Promise<MachineLeaveAnswer> {
  return async (key) => {
    const m = o.targets().find((t) => 'client' in t && t.client.key === key);
    o.links.leave(o.userId, key);
    if (!m || !('client' in m)) return { jobs: 0, retired: true };
    const jobs = o.jobsOn(m.name).length;
    if (jobs > 0 || !m.client.pool) return { jobs, retired: false };
    const r = await o.edit({ action: 'remove', role: 'machine-source', name: m.name, version: o.config.version(PLUGINS) });
    return r.ok ? { jobs: 0, retired: true } : { jobs: 0, retired: false };
  };
}
