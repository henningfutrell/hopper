// The sweep's test rig (issue #410): jobs, an empty survey, and the sweep runner with a fake machine shell, the store's
// jobs and work trail as plain lists. Shared by the sweep's tests.
import type { DomainEvent, Job, Leftover, MachineSnapshot } from '../../src/domain/types.ts';
import type { Executor, MachineShell, Survey } from '../../src/domain/ports.ts';
import { createSweep } from '../../src/engine/sweep.ts';
import type { LedgerEntry } from '../../src/domain/resource-ledger.ts';

export const HOUR = 3600_000;
export const job = (id: string, status: Job['status'], cwd = '/w'): Job => ({
  id, spec: { executor: 'x', payload: {}, machineId: 'm' }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1, executorState: { cwd },
});
export const none: Survey = { scopes: [], processes: [], scratch: [] };

/** The sweep with a fake machine shell; the store's jobs and work trail as plain lists. */
export function rig(o: { found?: Survey; surveys?: Survey[]; kept?: string[]; machines?: MachineSnapshot[]; keeps?: string[]; oldClient?: boolean; itemDone?: string[]; budget?: number; containers?: string[]; others?: Job[]; spec?: Partial<Job['spec']>; reapGate?: Promise<void>; reapFails?: string; lefts?: string[]; leftovers?: Leftover[] | 'old client' | 'fails'; removal?: 'removed' | 'gone' | 'left'; tips?: string[]; proxied?: string[]; reasons?: string[]; ledger?: LedgerEntry[] } = {}) {
  let now = Date.parse('2026-10-08T00:00:00Z');
  // The disk budget (issue #1120), in bytes; absent: none. `surveys`: what each survey finds in turn, then `found`.
  let budget = o.budget;
  const surveys = [...(o.surveys ?? [])];
  // Each job works the item `item:<id>`; the ledger holds the items of `itemDone` done. `others`: newer jobs; `spec`: added to each spec.
  const jobs = [...[job('done', 'finished', '/w'), job('run', 'running', '/v'), job('old', 'failed', '/w')].map((j) => ({ ...j, spec: { ...j.spec, ...o.spec }, source: { source: 's', kind: 'github', key: `item:${j.id}` } }) as Job), ...(o.others ?? [])];
  const events: { type: string; jobId?: string; machineId?: string; data: unknown }[] = (o.kept ?? []).map((id) => ({ type: 'job.work_kept', jobId: id, data: { paths: ['x'] } }));
  // `proxied`: the jobs whose commit `tip-<id>` the hopper pushed (issue #2087); `tips`: the jobs whose kept repository names that tip.
  for (const id of o.proxied ?? []) events.push({ type: 'github_proxy.done', jobId: id, data: { requestId: 'r', op: 'git.push', repo: 'o/r', refs: ['refs/heads/x'], heads: [`tip-${id}`] } });
  const ledger = o.ledger ?? [];
  const surveyed: string[][] = [];
  const reaps: { jobId: string; scratch?: string; discard?: boolean }[] = [];
  const logs: string[] = [];
  // The leftovers listings asked (issue #1116), with their work trees, and the removals asked.
  const listings: string[][] = [];
  const removals: string[] = [];
  const shell: MachineShell = {
    async leftovers(roots) {
      listings.push(roots);
      if (o.leftovers === 'old client') throw new Error('client m runs an older client release: /leftovers not found');
      if (o.leftovers === 'fails') throw new Error('the leftovers listing on m did not finish');
      return o.leftovers ?? [];
    },
    async removeLeftover(path) { removals.push(path); return o.removal ?? 'removed'; },
    async survey(roots) { surveyed.push(roots); return surveys.shift() ?? o.found ?? none; },
    async reap(jobId, scratch, _keep, discard) {
      reaps.push({ jobId, ...(scratch ? { scratch } : {}), ...(discard ? { discard } : {}) });
      // `reapGate`: the reap ends once it settles (a slow machine, issue #1194); `reapFails`: it cannot reach the machine.
      await o.reapGate;
      if (o.reapFails) throw new Error(o.reapFails);
      // `containers`: the jobs whose reap removed a container and a volume (issue #1120), the container's details said (issue #975).
      const removed = o.containers?.includes(jobId) ? { removed: { containers: [`c-${jobId}`], volumes: [`v-${jobId}`], details: [{ id: `c-${jobId}`, name: 'db', image: 'postgres:16' }] } } : {};
      const kept = scratch && (!discard || o.oldClient) && o.keeps?.includes(jobId) ? [`${scratch}/repo`] : [];
      // `lefts`: the jobs whose scratch dir the reap could not remove (issue #1452).
      const left = scratch && kept.length === 0 && o.lefts?.includes(jobId) ? { left: [scratch] } : {};
      const tips = kept.length > 0 && o.tips?.includes(jobId) ? { tips: { [kept[0]!]: [`tip-${jobId}`] } } : {};
      // `reasons`: the jobs whose reap said why it kept their work (issue #2494).
      const reasons = kept.length > 0 && o.reasons?.includes(jobId) ? { reasons: { [kept[0]!]: ['unpushed' as const] } } : {};
      return { kept, ...tips, ...reasons, ...left, ...removed };
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
      jobs: {
        list: () => jobs, get: (id: string) => jobs.find((j) => j.id === id), getBySourceKey: (key: string) => jobs.findLast((j) => j.source?.key === key),
        // A discard is a record on the job (issue #1570): a patch's undefined removes the field.
        update: (id: string, patch: Partial<Job>) => {
          const i = jobs.findIndex((j) => j.id === id);
          const next = { ...jobs[i]!, ...patch } as Job;
          for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
          jobs[i] = next;
          return next;
        },
      },
      tx: <T>(fn: () => T): T => fn(),
      events: {
        recent: (_limit: number, types: string[], jobId?: string) => events.filter((e) => types.includes(e.type) && (!jobId || e.jobId === jobId)).reverse() as unknown as DomainEvent[],
        append: (e: { type: string; jobId?: string; machineId?: string; data: unknown }) => { events.push(e); return e as unknown as DomainEvent; },
      },
      workItems: { get: (key: string) => (o.itemDone?.some((id) => key === `item:${id}`) ? { key, state: 'done' } : undefined) },
      settings: { getDiskBudget: () => (budget === undefined ? undefined : { bytes: budget }) },
      // The resource ledger (issue #2504): `ledger`'s entries, closed in place.
      resourceLedger: {
        forJob: (id: string) => ledger.filter((e) => e.jobId === id),
        close: (id: string, kind: string, locator: string, state: LedgerEntry['state'], at: string, reason?: string) => {
          const e = ledger.find((x) => x.jobId === id && x.kind === kind && x.locator === locator && (x.state === 'live' || x.state === 'kept'));
          if (e) Object.assign(e, { state, endedAt: at, ...(reason ? { reason } : {}) });
        },
      },
    } as never,
  }, (l) => logs.push(l));
  return { sweep, jobs, ledger, surveyed, reaps, events, logs, listings, removals, advance: (ms: number) => { now += ms; }, setBudget: (b: number | undefined) => { budget = b; } };
}
