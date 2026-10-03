// Job lifecycle after a claim: started → progressed (throttled) → finished | failed |
// cancelled | waiting_answer. A claim of a job with a pending answer resumes it.
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { Job, LaneId } from '../domain/types.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';
import { recordOutcome } from './outcome.ts';

const PROGRESS_EVERY_MS = 500;

interface Running {
  controller: AbortController;
  /** Set by cancel(): the reason recorded on job.cancelled. */
  cancelReason?: string;
  done: Promise<void>;
}

export interface Runner {
  start(claim: Claim): void;
  /** Abort a claimed/running job as a cancel, recorded with `reason`. False when it is not running here. */
  cancel(jobId: string, reason: string): boolean;
  /** Abort everything for shutdown and wait up to `ms`. Nothing is written afterwards. */
  stopAll(ms: number): Promise<void>;
}

/** Abort reasons the executor reads from `ctx.signal.reason` (ports.ts ExecutionContext). */
const CANCEL = 'cancel';
const SHUTDOWN = 'shutdown';

async function execute(executor: Executor | undefined, job: Job, ctx: ExecutionContext): Promise<ExecutionOutcome> {
  if (!executor) return { kind: 'failed', error: `executor ${job.spec.executor} is not registered` };
  if (job.pendingAnswer === undefined) return executor.run(ctx);
  if (!executor.resume) return { kind: 'failed', error: `executor ${executor.name} cannot resume` };
  return executor.resume(ctx, job.pendingAnswer);
}

export function createRunner(c: EngineContext, cleanup: Cleanup): Runner {
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
      outcome = await execute(executor, started, {
        job: started, laneId: claim.laneId, signal: entry.controller.signal,
        progress: (f, m) => progress.report(f, m),
        saveState: (state) => { if (!c.stopping()) store.jobs.update(job.id, { executorState: state }); },
      });
    } catch (e) {
      outcome = { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    // Shutdown: leave the job running in the store; restart recovery decides its fate.
    if (c.stopping() && entry.cancelReason === undefined) return;
    progress.flush();
    const recorded = recordOutcome(c, started, claim.laneId, outcome, entry.cancelReason);
    if (recorded.kind === 'question') c.questions.handle(recorded.questionId);
    else await cleanup(job.id);
  }

  return {
    start(claim) {
      const entry: Running = { controller: new AbortController(), done: Promise.resolve() };
      running.set(claim.jobId, entry);
      entry.done = run(claim, entry)
        .catch((e) => console.error('job runner failed', claim.jobId, e))
        .finally(() => { if (running.get(claim.jobId) === entry) running.delete(claim.jobId); });
    },
    cancel(jobId, reason) {
      const entry = running.get(jobId);
      if (!entry) return false;
      entry.cancelReason = reason;
      entry.controller.abort(CANCEL);
      return true;
    },
    async stopAll(ms) {
      const all = [...running.values()];
      for (const r of all) r.controller.abort(SHUTDOWN);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, ms); });
      await Promise.race([Promise.all(all.map((r) => r.done)), timeout]);
      clearTimeout(timer);
    },
  };
}
