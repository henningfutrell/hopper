// Read models for the HTTP edge.
import { order } from '../decider/assign.ts';
import { routerVerdict } from '../decider/router-verdict.ts';
import { laneCap, machineUsage } from '../decider/usage.ts';
import { TERMINAL_STATUSES, type Job, type JobStatus, type Lane, type MachineSnapshot, type UsageReading, type UsageReport, type UsageSourceReport } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface QueueView {
  waiting: Job[];
  running: Job[];
  /** Jobs paused on a question, oldest first. They hold no lane. */
  waitingAnswer: Job[];
  /** Ended jobs (finished, failed, cancelled), newest end first, at most `ENDED_CAP`. */
  ended: Job[];
  counts: Record<JobStatus, number>;
}

export const ENDED_CAP = 20;

export type MachineView = MachineSnapshot & { lanes: Lane[]; usage: UsageReading[] };

export interface Queries {
  getQueue(): QueueView;
  getMachines(): Promise<MachineView[]>;
  getUsage(): Promise<UsageReading[]>;
  /** Every reading, every usage source's state, the limits, and the lane effect per machine (the decider's steps 1-2). */
  getUsageReport(): Promise<UsageReport>;
  /** Each usage source's name and state (when it last read, why it has no readings, its account). */
  getUsageSources(): UsageSourceReport[];
  /** Jobs that need a machine: on a busy or draining lane there, or waiting for an answer in a pane there (`resumeOn`). */
  jobsOnMachine(machineId: string): string[];
}

export function createQueries(c: EngineContext): Queries {
  const getUsage = async (): Promise<UsageReading[]> => (await Promise.all(c.usage.map((u) => u.poll()))).flat();
  const getUsageSources = (): UsageSourceReport[] => c.usage.map((u) => ({ name: u.name, ...u.state?.() }));
  return {
    getQueue() {
      const all = c.store.jobs.list();
      const counts: Record<JobStatus, number> = {
        queued: 0, held: 0, claimed: 0, running: 0, waiting_answer: 0, finished: 0, failed: 0, cancelled: 0,
      };
      for (const j of all) counts[j.status] += 1;
      const active = c.routerMode() === 'active';
      // The decider's own order: effective priority (router boost only in active mode), then age.
      const waiting = order(all.filter((j) => j.status === 'queued' || j.status === 'held').map((job) => {
        const v = routerVerdict(job, c.policy.routerCheapBoost);
        return { job, effectivePriority: job.priority + (active && v.admit ? v.boost : 0) };
      })).map((x) => x.job);
      const running = all.filter((j) => j.status === 'claimed' || j.status === 'running').reverse();
      const waitingAnswer = all.filter((j) => j.status === 'waiting_answer').reverse();
      const end = (j: Job) => j.finishedAt ?? j.updatedAt;
      const ended = all.filter((j) => TERMINAL_STATUSES.includes(j.status))
        .sort((a, b) => end(b).localeCompare(end(a))).slice(0, ENDED_CAP);
      return { waiting, running, waitingAnswer, ended, counts };
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
    getUsageSources,
    async getUsageReport() {
      const [machines, readings] = await Promise.all([c.machines.list(), getUsage()]);
      return {
        readings,
        sources: getUsageSources(),
        limits: { soft: c.policy.softLimit, hard: c.policy.hardLimit },
        machines: machines.map((m) => {
          const { usedFrac } = machineUsage(m.id, readings);
          const { cap, band } = laneCap(m, usedFrac, c.policy);
          return { machineId: m.id, label: m.label, online: m.online, maxLanes: m.maxLanes, usedFrac, cap, band };
        }),
      };
    },
    jobsOnMachine(machineId) {
      const onLanes = c.store.lanes.list(machineId).flatMap((l) => (l.state !== 'idle' && l.jobId ? [l.jobId] : []));
      const parked = c.store.jobs.list({ status: ['waiting_answer'] }).filter((j) => j.resumeOn === machineId).map((j) => j.id);
      return [...new Set([...onLanes, ...parked])];
    },
  };
}
