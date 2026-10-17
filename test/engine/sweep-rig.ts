// The sweep's test rig (issue #410): jobs, an empty survey, and the sweep runner with a fake machine shell, the store's
// jobs and work trail as plain lists. Shared by the sweep's tests.
import type { DomainEvent, Job, MachineSnapshot } from '../../src/domain/types.ts';
import type { Executor, MachineShell, Survey } from '../../src/domain/ports.ts';
import { createSweep } from '../../src/engine/sweep.ts';

export const HOUR = 3600_000;
export const job = (id: string, status: Job['status'], cwd = '/w'): Job => ({
  id, spec: { executor: 'x', payload: {}, machineId: 'm' }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1, executorState: { cwd },
});
export const none: Survey = { scopes: [], processes: [], scratch: [] };

/** The sweep with a fake machine shell; the store's jobs and work trail as plain lists. */
export function rig(o: { found?: Survey; surveys?: Survey[]; kept?: string[]; machines?: MachineSnapshot[]; keeps?: string[]; oldClient?: boolean; itemDone?: string[]; budget?: number; containers?: string[]; others?: Job[]; spec?: Partial<Job['spec']>; reapGate?: Promise<void>; reapFails?: string; lefts?: string[] } = {}) {
  let now = Date.parse('2026-10-08T00:00:00Z');
  // The disk budget (issue #1120), in bytes; absent: none. `surveys`: what each survey finds in turn, then `found`.
  let budget = o.budget;
  const surveys = [...(o.surveys ?? [])];
  // Each job works the item `item:<id>`; the ledger holds the items of `itemDone` done. `others`: newer jobs; `spec`: added to each spec.
  const jobs = [...[job('done', 'finished', '/w'), job('run', 'running', '/v'), job('old', 'failed', '/w')].map((j) => ({ ...j, spec: { ...j.spec, ...o.spec }, source: { source: 's', kind: 'github', key: `item:${j.id}` } }) as Job), ...(o.others ?? [])];
  const events: { type: string; jobId?: string; machineId?: string; data: unknown }[] = (o.kept ?? []).map((id) => ({ type: 'job.work_kept', jobId: id, data: { paths: ['x'] } }));
  const surveyed: string[][] = [];
  const reaps: { jobId: string; scratch?: string; discard?: boolean }[] = [];
  const logs: string[] = [];
  const shell: MachineShell = {
    async survey(roots) { surveyed.push(roots); return surveys.shift() ?? o.found ?? none; },
    async reap(jobId, scratch, _keep, discard) {
      reaps.push({ jobId, ...(scratch ? { scratch } : {}), ...(discard ? { discard } : {}) });
      // `reapGate`: the reap ends once it settles (a slow machine, issue #1194); `reapFails`: it cannot reach the machine.
      await o.reapGate;
      if (o.reapFails) throw new Error(o.reapFails);
      // `containers`: the jobs whose reap removed a container and a volume (issue #1120).
      const removed = o.containers?.includes(jobId) ? { removed: { containers: [`c-${jobId}`], volumes: [`v-${jobId}`] } } : {};
      const kept = scratch && (!discard || o.oldClient) && o.keeps?.includes(jobId) ? [`${scratch}/repo`] : [];
      // `lefts`: the jobs whose scratch dir the reap could not remove (issue #1452).
      const left = scratch && kept.length === 0 && o.lefts?.includes(jobId) ? { left: [scratch] } : {};
      return { kept, ...left, ...removed };
    },
    async keepCredential() { throw new Error('not asked'); },
    async reach() { throw new Error('not asked'); },
    async discover() { throw new Error('not asked'); },
  };
  const executor = { name: 'x', validate: () => null, run: async () => ({ kind: 'failed' as const, error: '' }), machineShell: (m: MachineSnapshot) => (m.id === 'unreachable' ? undefined : shell) } satisfies Executor;
  const machines = o.machines ?? [{ id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['x'] }];
  const sweep = createSweep({
    clock: { now: () => new Date(now) },
    stopping: () => false,
    machines: { list: async () => machines },
    executors: { get: (n: string) => (n === 'x' ? executor : undefined), names: () => ['x'] } as never,
    store: {
      jobs: { list: () => jobs, get: (id: string) => jobs.find((j) => j.id === id), getBySourceKey: (key: string) => jobs.findLast((j) => j.source?.key === key) },
      events: {
        recent: (_limit: number, types: string[], jobId?: string) => events.filter((e) => types.includes(e.type) && (!jobId || e.jobId === jobId)).reverse() as unknown as DomainEvent[],
        append: (e: { type: string; jobId?: string; machineId?: string; data: unknown }) => { events.push(e); return e as unknown as DomainEvent; },
      },
      workItems: { get: (key: string) => (o.itemDone?.some((id) => key === `item:${id}`) ? { key, state: 'done' } : undefined) },
      settings: { getDiskBudget: () => (budget === undefined ? undefined : { bytes: budget }) },
    } as never,
  }, (l) => logs.push(l));
  return { sweep, surveyed, reaps, events, logs, advance: (ms: number) => { now += ms; }, setBudget: (b: number | undefined) => { budget = b; } };
}
