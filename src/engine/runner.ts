// Job lifecycle after a claim: started → progressed (throttled) → finished | failed | cancelled.
import type { ExecutionOutcome } from '../domain/ports.ts';
import type { Job, LaneId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';

const PROGRESS_EVERY_MS = 500;

interface Running {
  controller: AbortController;
  cancelled: boolean;
  done: Promise<void>;
}

export interface Runner {
  start(claim: Claim): void;
  /** Abort a claimed/running job as a cancel. False when it is not running here. */
  cancel(jobId: string): boolean;
  /** Abort everything for shutdown and wait up to `ms`. Nothing is written afterwards. */
  stopAll(ms: number): Promise<void>;
}

export function createRunner(c: EngineContext): Runner {
  const running = new Map<string, Running>();

  function progressReporter(jobId: string, laneId: LaneId) {
    let lastAt = -Infinity;
    let pending: { fraction: number; message?: string } | undefined;
    const emit = (p: { fraction: number; message?: string }): void => {
      lastAt = c.clock.now().getTime();
      pending = undefined;
      c.store.tx(() => {
        c.store.jobs.update(jobId, { progress: p.fraction, progressMessage: p.message });
        c.store.events.append({ type: 'job.progressed', jobId, laneId, data: { progress: p.fraction, message: p.message } });
      });
    };
    return {
      report(fraction: number, message?: string): void {
        if (c.stopping()) return;
        const p = { fraction: Math.max(0, Math.min(1, fraction)), ...(message !== undefined ? { message } : {}) };
        if (c.clock.now().getTime() - lastAt >= PROGRESS_EVERY_MS) emit(p);
        else pending = p;
      },
      flush(): void {
        if (pending && !c.stopping()) emit(pending);
      },
    };
  }

  function finish(job: Job, laneId: LaneId, outcome: ExecutionOutcome, cancelled: boolean): void {
    const at = nowIso(c);
    const { store } = c;
    store.tx(() => {
      if (cancelled) {
        store.jobs.update(job.id, { status: 'cancelled', finishedAt: at });
        store.events.append({ type: 'job.cancelled', jobId: job.id, laneId, data: { reason: 'cancelled while running' } });
      } else if (outcome.ok) {
        store.jobs.update(job.id, { status: 'finished', result: outcome.result, finishedAt: at });
        store.events.append({ type: 'job.finished', jobId: job.id, laneId, data: { result: outcome.result } });
      } else {
        store.jobs.update(job.id, { status: 'failed', error: outcome.error, finishedAt: at });
        store.events.append({ type: 'job.failed', jobId: job.id, laneId, data: { error: outcome.error } });
      }
      const lane = store.lanes.list().find((l) => l.id === laneId);
      if (!lane) return;
      if (lane.state === 'draining') {
        store.lanes.close(laneId);
        store.events.append({ type: 'lane.closed', laneId, machineId: lane.machineId, data: { reason: 'drained' } });
      } else {
        store.lanes.update(laneId, { state: 'idle', jobId: undefined, idleSince: at });
      }
    });
  }

  async function run(claim: Claim, entry: Running): Promise<void> {
    const { store } = c;
    const job = store.jobs.get(claim.jobId);
    if (!job) return;
    const executor = c.executors.get(job.spec.executor);
    const started = store.tx(() => {
      const j = store.jobs.update(job.id, { status: 'running', startedAt: nowIso(c) });
      store.events.append({ type: 'job.started', jobId: job.id, laneId: claim.laneId, data: { attempts: j.attempts } });
      return j;
    });
    const progress = progressReporter(job.id, claim.laneId);
    let outcome: ExecutionOutcome;
    try {
      if (!executor) throw new Error(`executor ${job.spec.executor} is not registered`);
      outcome = await executor.run({
        job: started, laneId: claim.laneId, signal: entry.controller.signal,
        progress: (f, m) => progress.report(f, m),
      });
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // Shutdown: leave the job running in the store; restart recovery requeues it.
    if (c.stopping() && !entry.cancelled) return;
    progress.flush();
    finish(started, claim.laneId, outcome, entry.cancelled);
  }

  return {
    start(claim) {
      const entry: Running = { controller: new AbortController(), cancelled: false, done: Promise.resolve() };
      running.set(claim.jobId, entry);
      entry.done = run(claim, entry)
        .catch((e) => console.error('job runner failed', claim.jobId, e))
        .finally(() => running.delete(claim.jobId));
    },
    cancel(jobId) {
      const entry = running.get(jobId);
      if (!entry) return false;
      entry.cancelled = true;
      entry.controller.abort(new Error('cancelled'));
      return true;
    },
    async stopAll(ms) {
      const all = [...running.values()];
      for (const r of all) r.controller.abort(new Error('daemon shutdown'));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, ms); });
      await Promise.race([Promise.all(all.map((r) => r.done)), timeout]);
      clearTimeout(timer);
    },
  };
}
