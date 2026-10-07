// The queue gate (issue #159, design.md "Queue gate"): a new job waits unaccepted until the pre-sort
// or the user accepts it, or is rejected — kept, ended `rejected`, never run. The pre-sort is the
// queue sorter over the jobs not yet accepted: its order and its rejections. Auto-accept applies it
// before each Decision, at most `autoAcceptPerHour` jobs an hour; review leaves it to the user.
import { effectivePriority } from '../decider/assign.ts';
import { DEFAULT_QUEUE_GATE } from '../domain/types.ts';
import type { GateActor, Job, PreSort, QueueGate } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

const HOUR_MS = 3_600_000;
/** The most recent acceptances read to count the last hour's: well past any useful throttle. */
const ACCEPTANCES_READ = 1000;

export const isWaiting = (j: Job): boolean => j.status === 'queued' || j.status === 'held';
export const isUnaccepted = (j: Job): boolean => isWaiting(j) && j.accepted === false;

export const gateOf = (c: EngineContext): QueueGate => c.store.settings.getQueueGate() ?? DEFAULT_QUEUE_GATE;

/** The queue sorter over the jobs not yet accepted: their order and the ones it rejects. */
export function preSort(c: EngineContext, unaccepted: readonly Job[]): PreSort {
  const entries = unaccepted.map((job) => ({ job, effectivePriority: effectivePriority(job, c.policy) }));
  return { sorter: c.queueSorter.name, jobIds: entries.length ? c.queueSorter.sort(entries) : [], reject: c.queueSorter.reject?.(entries) ?? [] };
}

/** The waiting jobs not yet accepted, oldest first. */
export const unacceptedJobs = (c: EngineContext): Job[] => c.store.jobs.list({ status: ['queued', 'held'] }).filter(isUnaccepted).reverse();

/** Accept one waiting job, in the caller's transaction. */
export function acceptJob(c: EngineContext, job: Job, by: GateActor, userRank?: number): void {
  c.store.jobs.update(job.id, { accepted: true, ...(userRank === undefined ? {} : { userRank }) });
  c.store.events.append({ type: 'job.accepted', jobId: job.id, data: { by } });
}

/** End one waiting job `rejected`, in the caller's transaction. Its reason is its error. */
export function rejectJob(c: EngineContext, job: Job, by: GateActor, reason: string): Job {
  const next = c.store.jobs.update(job.id, { status: 'rejected', error: reason, holdReason: undefined, waitReason: undefined, finishedAt: nowIso(c), pendingAnswer: undefined });
  c.store.events.append({ type: 'job.rejected', jobId: job.id, data: { by, reason } });
  return next;
}

/** Apply the pre-sort to every job not yet accepted, in its order: reject what it rejects, accept up to `limit` of the rest. */
function applyPreSort(c: EngineContext, unaccepted: readonly Job[], p: PreSort, limit: number): void {
  const rejected = new Map(p.reject.map((r) => [r.jobId, r.reason]));
  const byId = new Map(unaccepted.map((j) => [j.id, j]));
  const ordered = [...new Set([...p.jobIds, ...unaccepted.map((j) => j.id)])].map((id) => byId.get(id)!);
  let left = limit;
  c.store.tx(() => {
    for (const job of ordered) {
      const reason = rejected.get(job.id);
      if (reason !== undefined) rejectJob(c, job, 'pre-sort', reason);
      else if (left > 0) { acceptJob(c, job, 'pre-sort'); left--; }
    }
  });
}

/** How many more jobs the pre-sort may accept this hour. */
function allowance(c: EngineContext, gate: QueueGate): number {
  if (gate.autoAcceptPerHour === null) return Infinity;
  const since = new Date(c.clock.now().getTime() - HOUR_MS).toISOString();
  const recent = c.store.events.recent(ACCEPTANCES_READ, ['job.accepted']).filter((e) => e.at >= since && e.data.by === 'pre-sort');
  return Math.max(0, gate.autoAcceptPerHour - recent.length);
}

/** Before each Decision: an auto-accepting gate applies the pre-sort, throttled. */
export function autoAccept(c: EngineContext): void {
  const gate = gateOf(c);
  if (gate.mode !== 'auto-accept') return;
  const unaccepted = unacceptedJobs(c);
  if (unaccepted.length) applyPreSort(c, unaccepted, preSort(c, unaccepted), allowance(c, gate));
}

export interface QueueGateCommands {
  setQueueGate(gate: QueueGate): QueueGate;
  /**
   * The user order: these waiting jobs, first to last. Each is accepted (by the user) if it was not;
   * a waiting job ranked before and not listed loses its rank.
   */
  orderQueue(jobIds: readonly string[]): Job[];
  /** Reject a waiting job: it ends `rejected`, its source is told. */
  reject(id: string): Job;
  /** Apply the pre-sort now, whatever the gate: reject what it rejects, accept the rest. */
  acceptPreSort(): PreSort;
}

export const USER_REJECTED = 'rejected by the user';

export function createQueueGateCommands(c: EngineContext, cleanup: (jobId: string) => void): QueueGateCommands {
  const { store } = c;
  return {
    setQueueGate(gate) {
      const from = gateOf(c);
      const to: QueueGate = { mode: gate.mode, autoAcceptPerHour: gate.autoAcceptPerHour };
      if (from.mode === to.mode && from.autoAcceptPerHour === to.autoAcceptPerHour) return to;
      store.tx(() => {
        store.settings.setQueueGate(to);
        store.events.append({ type: 'queue.gate_changed', data: { from, to } });
      });
      return to;
    },

    orderQueue(jobIds) {
      return store.tx(() => {
        const jobs = jobIds.map((id) => {
          const job = store.jobs.get(id);
          if (!job || !isWaiting(job)) throw new EngineError('conflict', `job ${id} is not waiting`);
          return job;
        });
        const listed = new Set(jobIds);
        for (const j of store.jobs.list({ status: ['queued', 'held'] })) {
          if (j.userRank !== undefined && !listed.has(j.id)) store.jobs.update(j.id, { userRank: undefined });
        }
        jobs.forEach((job, rank) => {
          if (job.accepted === false) acceptJob(c, job, 'user', rank);
          else store.jobs.update(job.id, { userRank: rank });
        });
        store.events.append({ type: 'queue.ordered', data: { jobIds: [...jobIds] } });
        return jobIds.map((id) => store.jobs.get(id)!);
      });
    },

    reject(id) {
      const job = store.jobs.get(id);
      if (!job) throw new EngineError('not_found', `job ${id} not found`);
      if (!isWaiting(job)) throw new EngineError('conflict', `job ${id} is ${job.status}: only a waiting job can be rejected`);
      const next = store.tx(() => rejectJob(c, job, 'user', USER_REJECTED));
      // A waiting job resuming with an answer holds a pane.
      if (job.resumeOn !== undefined) cleanup(id);
      return next;
    },

    acceptPreSort() {
      const unaccepted = unacceptedJobs(c);
      const p = preSort(c, unaccepted);
      if (unaccepted.length) applyPreSort(c, unaccepted, p, Infinity);
      return p;
    },
  };
}
