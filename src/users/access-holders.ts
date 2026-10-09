// The permission matrix's rows beside the templates (issue #559): every user's machines that joined as a box of a
// template, and their live jobs on such a machine. A job's machine is its lane's, else the one it resumes on; its
// template is that machine's, from its join line, never from the job. Ids and names only.
import { LIVE_JOB_STATUSES } from '../authz/service.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import type { AccessHolders, JobStatus } from '../domain/types.ts';
import type { UserRuntime } from './runtime.ts';

const byName = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

export function accessHolders(runtimes: readonly Pick<UserRuntime, 'user' | 'store' | 'host'>[]): AccessHolders {
  const holders: AccessHolders = { machines: [], jobs: [] };
  for (const rt of runtimes) {
    const user = rt.user.id;
    const boxes = new Map(rt.host.targets().flatMap((m) => ('client' in m && m.client.template ? [[m.name, m.client.template] as const] : [])));
    for (const [machine, template] of boxes) holders.machines.push({ user, machine, template });
    for (const job of rt.store.jobs.list({ status: LIVE_JOB_STATUSES as JobStatus[] })) {
      const machine = machineOfLane(job.laneId) ?? job.resumeOn;
      const template = machine === undefined ? undefined : boxes.get(machine);
      if (machine !== undefined && template !== undefined) holders.jobs.push({ user, job: job.id, machine, template, status: job.status });
    }
  }
  holders.machines.sort(byName((m) => `${m.template} ${m.user} ${m.machine}`));
  holders.jobs.sort(byName((j) => `${j.template} ${j.user} ${j.machine} ${j.job}`));
  return holders;
}
