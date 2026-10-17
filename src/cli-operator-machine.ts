// Draining a machine from the command line (issue #1511, design.md "Draining a machine"): `hopper machine drain <machine>`
// stops new placement on it — the jobs on it run to their end —, `undrain` lets new jobs on it again, each through the
// route the Machines view posts to (POST /ui/api/machines/drain); `list` prints each machine, online or not, and drained
// or not, from GET /api/machines.
import { usage, type Call } from './cli-operator-call.ts';
import type { MachineSnapshot } from './domain/types.ts';

export const MACHINE_USAGE = `  hopper machine list                                each machine: online or not, drained or not, and its lanes
  hopper machine drain <machine>                     drain a machine: no new job is placed on it, the jobs on it run to their end
  hopper machine undrain <machine>                   undrain a machine: new jobs are placed on it again`;

type Listed = MachineSnapshot & { lanes?: unknown[] };

export function machineCall(args: string[]): Call {
  const [verb, machineId, ...extra] = args;
  if (verb === 'list' && machineId === undefined) {
    return {
      role: 'viewer', path: '/api/machines',
      pick: (a) => ((a as { machines: Listed[] }).machines).map((m) => ({
        id: m.id, label: m.label, online: m.online, maxLanes: m.maxLanes, lanes: m.lanes?.length ?? 0,
        ...(m.drained ? { drained: m.drained } : {}), ...(m.leaving ? { leaving: true } : {}),
      })),
    };
  }
  if ((verb === 'drain' || verb === 'undrain') && machineId && extra.length === 0) {
    return { role: 'admin', path: '/ui/api/machines/drain', body: async () => ({ machineId, drained: verb === 'drain' }) };
  }
  throw usage('machine list | hopper machine drain|undrain <machine>');
}
