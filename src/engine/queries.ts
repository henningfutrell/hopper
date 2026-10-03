// Read models for the HTTP edge.
import { order } from '../decider/assign.ts';
import { jevVerdict } from '../decider/jev-verdict.ts';
import type { Job, JobStatus, Lane, MachineSnapshot, UsageReading } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface QueueView {
  waiting: Job[];
  running: Job[];
  counts: Record<JobStatus, number>;
}

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Queries {
  getQueue(): QueueView;
  getMachines(): Promise<MachineView[]>;
  getUsage(): Promise<UsageReading[]>;
}

export function createQueries(c: EngineContext): Queries {
  const getUsage = async (): Promise<UsageReading[]> => (await Promise.all(c.usage.map((u) => u.poll()))).flat();
  return {
    getQueue() {
      const all = c.store.jobs.list();
      const counts: Record<JobStatus, number> = {
        queued: 0, held: 0, claimed: 0, running: 0, waiting_answer: 0, finished: 0, failed: 0, cancelled: 0,
      };
      for (const j of all) counts[j.status] += 1;
      const active = c.jevMode() === 'active';
      // The decider's own order: effective priority (Jev boost only in active mode), then age.
      const waiting = order(all.filter((j) => j.status === 'queued' || j.status === 'held').map((job) => {
        const v = jevVerdict(job, c.policy.jevCheapBoost);
        return { job, effectivePriority: job.priority + (active && v.admit ? v.boost : 0) };
      })).map((x) => x.job);
      const running = all.filter((j) => j.status === 'claimed' || j.status === 'running').reverse();
      return { waiting, running, counts };
    },
    async getMachines() {
      const [machines, usage] = await Promise.all([c.machines.list(), getUsage()]);
      const lanes = c.store.lanes.list();
      return machines.map((m) => ({
        ...m,
        lanes: lanes.filter((l) => l.machineId === m.id),
        usage: usage.filter((u) => u.machineId === undefined || u.machineId === m.id),
      }));
    },
    getUsage,
  };
}
