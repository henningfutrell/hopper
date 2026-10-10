// Job lifecycle after a claim: started → progressed (throttled) → finished | failed |
// cancelled | waiting_answer | parked. A claim of a job with a pending answer resumes it. A job
// reattached by restart recovery skips `started` and goes on from its executor's present state;
// one whose machine did not answer at recovery is asked again until it does (issue #368).
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import { finishBrief, MAX_FINISH_BRIEFS, type Job, type LaneId, type MachineSnapshot, type UnfinishedPullRequest } from '../domain/types.ts';
import { readJobRules, withAsks } from '../job-rules/index.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, type EngineContext } from './context.ts';
import { placeCredentials } from './credentials.ts';
import type { Claim } from './decision-step.ts';
import { recordOutcome } from './outcome.ts';
import { freshStartBrief, recordPark, releaseParked, startsFresh } from './park.ts';
import { withCorrection } from './answers.ts';
import { forkResume } from './phase-shifts.ts';
import { nudgeCheck } from './nudge-check.ts';

const PROGRESS_EVERY_MS = 500;
/** How often a job waiting for its machine after a restart asks again whether its work is alive. */
const REACHABLE_EVERY_MS = 1000;

interface Running {
  controller: AbortController;
  /** Set by cancel(): the reason recorded on job.cancelled. */
  cancelReason?: string;
  /** Set by park() (issue #501): the job is parked once its executor has stepped aside, unless it finished meanwhile. */
  parking?: boolean;
  done: Promise<void>;
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
  cancel(jobId: string, reason: string): boolean;
  /** Abort a running job to park it (issue #501): its lane frees once its executor has stepped aside. False when it is not running here. */
  park(jobId: string): boolean;
  /** Abort everything for shutdown and wait up to `ms`. Nothing is written afterwards. */
  stopAll(ms: number): Promise<void>;
}

/** Abort reasons the executor reads from `ctx.signal.reason` (ports.ts ExecutionContext). */
const CANCEL = 'cancel';
const PARK = 'park';
const SHUTDOWN = 'shutdown';

/** How a launch begins: a fresh run (or resume), a reattach, or a reattach once the machine answers. */
type Launch = 'run' | 'reattach' | 'reattach-when-reachable';

/** `answer`: the pending answer as the executor gets it — for a parked job starting fresh, wrapped in its brief (issue #530). */
async function execute(executor: Executor | undefined, job: Job, ctx: ExecutionContext, reattach: boolean, answer: string | undefined): Promise<ExecutionOutcome> {
  if (!executor) return { kind: 'failed', error: `executor ${job.spec.executor} is not registered` };
  if (reattach) return executor.reattach ? executor.reattach(ctx) : { kind: 'failed', error: `executor ${executor.name} cannot reattach` };
  if (answer === undefined) return executor.run(ctx);
  if (!executor.resume) return { kind: 'failed', error: `executor ${executor.name} cannot resume` };
  return executor.resume(ctx, answer);
}

/**
 * A job that ended done is finished only when its work is complete (issues #171, #187), or partly done — its own pull
 * request ships part of its item (issue #579): otherwise, or when that cannot be told, it fails, and its source never
 * reports it done. Its own pull request left with merge conflicts or as a draft (issue #626): while `mayContinue`, the
 * step that finishes it, for the job to go on with in place of a failure and its hand-off.
 */
async function completeOrFailed(c: EngineContext, job: Job, outcome: ExecutionOutcome, mayContinue: boolean): Promise<ExecutionOutcome | { finish: UnfinishedPullRequest }> {
  if (outcome.kind !== 'finished') return outcome;
  try {
    const v = await c.verdict(job);
    if (v.done) return outcome;
    if ('partlyDone' in v) return { ...outcome, partlyDone: v.partlyDone };
    return v.finish && mayContinue ? { finish: v.finish } : { kind: 'failed', error: `not complete: ${v.why}` };
  } catch (e) {
    return { kind: 'failed', error: `could not confirm the work is complete: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function createRunner(c: EngineContext, cleanup: Cleanup): Runner {
  const running = new Map<string, Running>();

  function progressReporter(jobId: string, laneId: LaneId) {
    let lastAt = -Infinity;
    let pending: { fraction: number; message?: string } | undefined;
    const emit = (p: { fraction: number; message?: string }): void => {
      lastAt = c.clock.now().getTime();
      pending = undefined;
      const masked = p.message !== undefined ? maskGitHubTokens(p.message) : undefined;
      c.store.tx(() => {
        c.store.jobs.update(jobId, { progress: p.fraction, progressMessage: masked });
        c.store.events.append({ type: 'job.progressed', jobId, laneId, data: { progress: p.fraction, message: masked } });
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

  /**
   * Issue #368: a client target dials in, an ssh target answers, some seconds after the daemon
   * starts. Undefined once the job's work is alive again and `job.reattached` is recorded; else the
   * outcome that ends it.
   */
  async function whenReachable(executor: Executor, job: Job, claim: Claim, machineId: string, signal: AbortSignal): Promise<ExecutionOutcome | undefined> {
    const until = c.clock.now().getTime() + c.reconnectGraceMs;
    for (;;) {
      const alive = await executor.canReattach!(job).catch(() => undefined);
      if (signal.aborted) return { kind: 'failed', error: 'aborted' };
      if (alive === false) return { kind: 'failed', error: 'interrupted by daemon restart' };
      if (alive) {
        if (!c.stopping()) c.store.events.append({ type: 'job.reattached', jobId: job.id, laneId: claim.laneId, data: { reason: 'daemon restart' } });
        return undefined;
      }
      if (c.clock.now().getTime() >= until) {
        return { kind: 'failed', error: `machine ${machineId} did not reconnect within ${c.reconnectGraceMs / 1000} s after the daemon restart` };
      }
      await sleep(REACHABLE_EVERY_MS, undefined, { signal }).catch(() => {});
    }
  }

  /** The machine snapshot of the lane's machine; undefined once it is no longer attached. */
  async function machineOf(laneId: LaneId): Promise<MachineSnapshot | undefined> {
    const lane = c.store.lanes.list().find((l) => l.id === laneId);
    return lane ? (await c.machines.list()).find((m) => m.id === lane.machineId) : undefined;
  }

  async function run(claim: Claim, entry: Running, launch: Launch): Promise<void> {
    const { store } = c;
    const job = store.jobs.get(claim.jobId);
    if (!job) return;
    const executor = c.executors.get(job.spec.executor);
    const machine = await machineOf(claim.laneId);
    const reattach = launch !== 'run';
    const started = reattach ? job : store.tx(() => {
      const j = store.jobs.update(job.id, { status: 'running', startedAt: nowIso(c) });
      store.events.append({ type: 'job.started', jobId: job.id, laneId: claim.laneId, data: { attempts: j.attempts } });
      return j;
    });
    const progress = progressReporter(job.id, claim.laneId);
    // A fork whose question was answered without it (issue #570) is told the answer first.
    // A person's correction of an earlier auto-answer (issue #632) goes in ahead of what it resumes with.
    const resumeWith = store.tx(() => withCorrection(c, started, forkResume(c, started, started.pendingAnswer !== undefined && startsFresh(started) ? freshStartBrief(c, started, started.pendingAnswer) : started.pendingAnswer)));
    const contextOf = (j: Job, m: MachineSnapshot): ExecutionContext => ({
      // The job rules as they are at this start (issue #172): an edit reaches the next job.
      job: j, laneId: claim.laneId, machine: m, signal: entry.controller.signal, jobRules: withAsks(readJobRules(store.config), j.spec, j.forkOf),
      // A login the job waits on (issue #476) goes to the logins, never into a question.
      logins: c.logins.forRun({ jobId: job.id, laneId: claim.laneId, machineId: m.id, run: job.spec.executor }, () => !c.stopping()),
      // The job acts through its source's connection (issue #214), its token kept current on its machine (issue #441).
      credentials: (scratch, make = false) => placeCredentials(c, started, m, executor?.machineShell?.(m), scratch, make, (line) => progress.report(0, line)),
      progress: (f, msg) => progress.report(f, msg),
      // Before a nudge (issue #627): the job's source, then what it waits on a person for.
      beforeNudge: () => nudgeCheck(c, j),
      saveState: (state) => { if (!c.stopping()) store.jobs.update(job.id, { executorState: state }); },
      workTree: (path) => { if (!c.stopping()) store.jobs.update(job.id, { workTree: path }); },
      agentSession: (id) => { if (!c.stopping()) store.jobs.update(job.id, { agentSession: id }); },
    });
    const attempt = async (go: () => Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
      try {
        return await go();
      } catch (e) {
        return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
    };
    let outcome = await attempt(async () => {
      const waited = machine && executor && launch === 'reattach-when-reachable'
        ? await whenReachable(executor, started, claim, machine.id, entry.controller.signal) : undefined;
      return !machine ? { kind: 'failed', error: `machine of lane ${claim.laneId} is not attached` } : waited ?? await execute(executor, started, contextOf(started, machine), reattach, resumeWith);
    });
    /** The job goes on in its own session, told `text`; undefined: its executor cannot resume it. */
    const resume = executor?.resume?.bind(executor);
    const goOn = machine && resume ? (j: Job, text: string) => resume(contextOf(j, machine), text) : undefined;
    // Its own pull request left with merge conflicts or as a draft (issue #626): the job goes on in its own session with
    // the fixed brief that finishes it, a few times at most, before it is judged as any other.
    for (let briefs = 0; ; briefs += 1) {
      // Parked mid-turn (issue #501): the executor left its pane as it was; it is ended now, the work tree and session kept.
      // A job that ended done meanwhile is recorded as any other.
      if (entry.parking && entry.cancelReason === undefined && outcome.kind !== 'finished' && !c.stopping()) {
        progress.flush();
        const parked = store.tx(() => recordPark(c, store.jobs.get(job.id) ?? started, 'running', claim.laneId));
        await releaseParked(c, parked);
        return;
      }
      if (entry.cancelReason !== undefined) break;
      const judged = await completeOrFailed(c, started, outcome, briefs < MAX_FINISH_BRIEFS && goOn !== undefined && !c.stopping() && !entry.parking);
      if (!('finish' in judged)) { outcome = judged; break; }
      const { finish } = judged;
      const now = store.tx(() => {
        store.events.append({ type: 'job.finish_briefed', jobId: job.id, laneId: claim.laneId, data: { pullRequest: finish.pullRequest, step: finish.step } });
        // A parked or continued job's run (issues #501, #551) reopened its session already: the brief types into that pane.
        const j = store.jobs.get(job.id) ?? started;
        return j.parked || j.continued ? store.jobs.update(job.id, { parked: undefined, continued: undefined }) : j;
      });
      outcome = await attempt(() => goOn!(now, finishBrief(finish)));
    }
    // Shutdown: leave the job running in the store; restart recovery decides its fate.
    if (c.stopping() && entry.cancelReason === undefined) return;
    progress.flush();
    const recorded = recordOutcome(c, started, claim.laneId, outcome, entry.cancelReason, machine);
    if (recorded.kind === 'question') c.questions.handle(recorded.questionId);
    else if (recorded.kind === 'report') c.reviews[recorded.review].handle(recorded.itemId);
    else await cleanup(job.id);
  }

  function launch(claim: Claim, how: Launch): void {
    const entry: Running = { controller: new AbortController(), done: Promise.resolve() };
    running.set(claim.jobId, entry);
    entry.done = run(claim, entry, how)
      .catch((e) => console.error('job runner failed', claim.jobId, e))
      .finally(() => { if (running.get(claim.jobId) === entry) running.delete(claim.jobId); });
  }

  return {
    start: (claim) => launch(claim, 'run'),
    reattach: (claim) => launch(claim, 'reattach'),
    reattachWhenReachable: (claim) => launch(claim, 'reattach-when-reachable'),
    cancel(jobId, reason) {
      const entry = running.get(jobId);
      if (!entry) return false;
      entry.cancelReason = reason;
      entry.controller.abort(CANCEL);
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
      const all = [...running.values()];
      for (const r of all) r.controller.abort(SHUTDOWN);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, ms); });
      await Promise.race([Promise.all(all.map((r) => r.done)), timeout]);
      clearTimeout(timer);
    },
  };
}
