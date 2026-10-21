// Draining a machine from the command line (issue #1511, design.md "Draining a machine"): `hopper machine drain <machine>`
// stops new placement on it — the jobs on it run to their end —, `undrain` lets new jobs on it again, each through the
// route the Machines view posts to (POST /ui/api/machines/drain); `list` prints each machine, online or not, and drained
// or not, from GET /api/machines. `sandbox-host` names the machines the user's sandboxes start on (issue #2272), first first,
// or clears it with `--clear`; with no machine it prints it (POST /ui/api/machines/sandbox-host, GET /api/machines).
// `podman-host` lists, adds and removes the user's Podman hosts (cli-operator-podman-host.ts).
import { usage, type Call } from './cli-operator-call.ts';
import { PODMAN_HOST_USAGE, podmanHostCall } from './cli-operator-podman-host.ts';
import type { MachineSnapshot } from './domain/types.ts';

export const MACHINE_USAGE = `  hopper machine list                                each machine: online or not, drained or not, and its lanes
  hopper machine drain <machine>                     drain a machine: no new job is placed on it, the jobs on it run to their end
  hopper machine undrain <machine>                   undrain a machine: new jobs are placed on it again
  hopper machine sandbox-host [<machine>...|--clear] the sandbox host: the machines sandboxes start on, first first (local: beside the hopper); none: print it
${PODMAN_HOST_USAGE}`;

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
  if (verb === 'podman-host') return podmanHostCall(args.slice(1));
  if (verb === 'sandbox-host') {
    const hosts = args.slice(1);
    if (hosts.length === 0) return { role: 'viewer', path: '/api/machines', pick: (a) => ({ hosts: (a as { sandboxHost?: string[] }).sandboxHost ?? [] }) };
    if (hosts.length === 1 && hosts[0] === '--clear') return { role: 'admin', path: '/ui/api/machines/sandbox-host', body: async () => ({ hosts: [] }) };
    if (!hosts.some((h) => h.startsWith('-'))) return { role: 'admin', path: '/ui/api/machines/sandbox-host', body: async () => ({ hosts }) };
  }
  throw usage('machine list | hopper machine drain|undrain <machine> | hopper machine sandbox-host [<machine>...|--clear] | hopper machine podman-host …');
}
