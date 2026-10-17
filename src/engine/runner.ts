// Job lifecycle after a claim: started → progressed (throttled) → finished | failed |
// cancelled | waiting_answer | parked. A claim of a job with a pending answer resumes it. A job
// reattached by restart recovery skips `started` and goes on from its executor's present state;
// one whose machine did not answer at recovery is asked again until it does (issue #368). A job whose machine's link drops
// while it runs is held on its lane the same way, and watched again once the link is back (issue #752).
// A claim's run is the saga kind `job-run` (issue #1662, job-run.ts): its coordinator drives the steps on whichever hopper
// holds it, and the runner does each step here, keeping what the run needs in memory (its abort, its progress, its
// sign-ins to mask). A reattach, or a run with no saga coordinator, the runner drives itself through the same steps.
import type { SagaStepContext } from '../sagas/coordinator.ts';
import type { Cleanup } from './cleanup.ts';
import type { EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';
import { JOB_RUN_STEPS, jobRunKey, jobRunSteps, left, type JobRunData, type JobRunStep, type Launch, type RunEntry, type TakenUp } from './job-run.ts';
import { runStep } from './run-step.ts';

interface Running extends RunEntry {
  /** Resolves when the run leaves this hopper: it ended, another hopper holds it, or this one stops. */
  done: Promise<void>;
  end(): void;
  /** A step of it runs here now (a run with no saga: always). Between two saga steps, nothing of it runs here. */
  stepping: boolean;
}

export interface Runner {
  start(claim: Claim): void;
  /** Watch a job restart recovery kept `running` on its lane (Executor.reattach). */
  reattach(claim: Claim): void;
  /**
   * A job restart recovery kept `running` on its lane though its machine did not answer: ask
   * `canReattach` again until it answers, then reattach it, or fail it once the reconnect grace
   * runs out. Cancel and shutdown abort the wait as they abort a run.
   */
  reattachWhenReachable(claim: Claim): void;
  /** Abort a claimed/running job as a cancel, recorded with `reason`. False when it is not running here. */
  cancel(jobId: string, reason: string, note?: string): boolean;
  /** Abort a running job to park it (issue #501): its lane frees once its executor has stepped aside. False when it is not running here. */
  park(jobId: string): boolean;
  /** Abort everything for shutdown and wait up to `ms`. Nothing is written afterwards. */
  stopAll(ms: number): Promise<void>;
  /** The jobs this runner drives now (issue #1662). */
  driving(): string[];
  /** Another hopper took the job's lease (issue #1662): its run here ends as at a shutdown, and writes no outcome. */
  drop(jobId: string): boolean;
  /** A step of a `job-run` saga, as the saga coordinator drives it on this hopper (issue #1662). Throws when the run is left here. */
  step(name: string, s: SagaStepContext): Promise<Record<string, unknown>>;
  /** The jobs on an open `job-run` saga at this hopper's start: their run, taken up again, says `daemon restart`. */
  restarted(jobIds: readonly string[]): void;
}

/** Abort reasons the executor reads from `ctx.signal.reason` (ports.ts ExecutionContext). */
const CANCEL = 'cancel';
const PARK = 'park';
const SHUTDOWN = 'shutdown';

export function createRunner(c: EngineContext, cleanup: Cleanup): Runner {
  const running = new Map<string, Running>();
  const steps = jobRunSteps(c, cleanup);
  const restartedHere = new Set<string>();

  function entryFor(jobId: string): Running {
    let end!: () => void;
    const done = new Promise<void>((r) => { end = r; });
    const entry: Running = { controller: new AbortController(), given: new Set(), done, end, stepping: false };
    running.set(jobId, entry);
    return entry;
  }

  /** The run leaves this hopper. Its lease ends with it (issue #1662): another hopper may take the job at once. */
  function finish(jobId: string, entry: Running): void {
    if (running.get(jobId) === entry) {
      running.delete(jobId);
      try { c.leases.release(jobId); } catch { /* the store closed: the lease ends by itself */ }
    }
    entry.end();
  }

  /** `again`: the step is tried again (its run taken up, `takenUp`). */
  function doStep(name: JobRunStep, e: RunEntry, d: JobRunData, again: boolean, takenUp: TakenUp | undefined): Promise<Partial<JobRunData>> | Partial<JobRunData> {
    if (name === 'run') return runStep(c, e, d, takenUp);
    if (name === 'pane') return steps.pane(e, d, again);
    return steps[name](e, d);
  }

  /** No saga: the steps in order, here, their data in memory. A run left here writes nothing more. */
  async function drive(e: Running, begin: JobRunData): Promise<void> {
    let data = begin;
    e.stepping = true;
    for (const name of JOB_RUN_STEPS) {
      if (left(c, e)) return;
      data = { ...data, ...(await doStep(name, e, data, false, undefined)) };
    }
  }

  function launch(claim: Claim, how: Launch): void {
    // Another hopper drives it (issue #1662): its lease is that hopper's.
    if (!c.leases.take(claim.jobId)) { console.warn(`job ${claim.jobId}: another hopper holds its lease; not driven here`); return; }
    const job = c.store.jobs.get(claim.jobId);
    const entry = entryFor(claim.jobId);
    if (!job) { finish(claim.jobId, entry); return; }
    const data: JobRunData = { jobId: job.id, attempt: job.attempts, laneId: claim.laneId, launch: how };
    // A claim's run is a saga (issue #1662): after a stop, any hopper on the database goes on with it. One not kept is driven here.
    try {
      if (how === 'run' && c.jobRuns?.begin(jobRunKey(job), data)) return;
    } catch (e) { console.warn(`job ${job.id}: its job-run saga was not kept (${e instanceof Error ? e.message : String(e)}); its run is driven here`); }
    drive(entry, data)
      .catch((e: unknown) => { if (!left(c, entry)) console.error('job runner failed', claim.jobId, e); })
      .finally(() => finish(claim.jobId, entry));
  }

  return {
    start: (claim) => launch(claim, 'run'),
    reattach: (claim) => launch(claim, 'reattach'),
    reattachWhenReachable: (claim) => launch(claim, 'reattach-when-reachable'),
    async step(name, s) {
      const d = s.data as unknown as JobRunData;
      if (!(JOB_RUN_STEPS as readonly string[]).includes(name)) throw new Error(`no step ${name} in a job run`);
      if (c.stopping()) throw new Error('the hopper stops');
      // Taken up here (issue #1662): this hopper holds the saga's lease, so it holds the job's lease too.
      let e = running.get(d.jobId);
      if (!e) { c.leases.take(d.jobId, true); e = entryFor(d.jobId); }
      const entry = e;
      // The saga's lease lost, or the hopper stops: the step ends as at a shutdown.
      const lost = (): void => { entry.dropped = true; entry.controller.abort(SHUTDOWN); };
      s.signal.addEventListener('abort', lost, { once: true });
      entry.stepping = true;
      const again = (s.saga.steps.find((t) => t.name === name)?.attempts ?? 1) > 1;
      const takenUp = again && name === 'run' ? (restartedHere.has(d.jobId) ? 'daemon restart' : 'its hopper stopped') : undefined;
      try {
        const out = await doStep(name as JobRunStep, entry, d, again, takenUp);
        if (left(c, entry)) throw new Error('the run is left here: this hopper stops, or another one holds the job');
        if (name === 'end') finish(d.jobId, entry);
        return out;
      } catch (err) {
        if (left(c, entry)) finish(d.jobId, entry);
        throw err;
      } finally {
        entry.stepping = false;
        s.signal.removeEventListener('abort', lost);
        // Stopped between its steps: it leaves now, the saga kept for the next hopper.
        if (c.stopping()) finish(d.jobId, entry);
      }
    },
    restarted(jobIds) { for (const id of jobIds) restartedHere.add(id); },
    cancel(jobId, reason, note) {
      const entry = running.get(jobId);
      if (!entry) return false;
      entry.cancelReason = reason;
      entry.cancelNote = note;
      entry.controller.abort(CANCEL);
      return true;
    },
    driving: () => [...running.keys()],
    drop(jobId) {
      const entry = running.get(jobId);
      if (!entry) return false;
      entry.dropped = true;
      entry.controller.abort(SHUTDOWN);
      // No step of it runs here now: it leaves at once. One that runs leaves when it ends.
      running.delete(jobId);
      entry.end();
      return true;
    },
    park(jobId) {
      const entry = running.get(jobId);
      if (!entry || entry.cancelReason !== undefined) return false;
      entry.parking = true;
      entry.controller.abort(PARK);
      return true;
    },
    async stopAll(ms) {
      const all = [...running.entries()];
      for (const [jobId, r] of all) {
        r.controller.abort(SHUTDOWN);
        // A saga's run between two steps: nothing of it runs here to wait for.
        if (!r.stepping) finish(jobId, r);
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, ms); });
      await Promise.race([Promise.all(all.map(([, r]) => r.done)), timeout]);
      clearTimeout(timer);
    },
  };
}
