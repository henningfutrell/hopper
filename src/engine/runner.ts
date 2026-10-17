// Job lifecycle after a claim: started → progressed (throttled) → finished | failed |
// cancelled | waiting_answer | parked. A claim of a job with a pending answer resumes it. A job
// reattached by restart recovery skips `started` and goes on from its executor's present state;
// one whose machine did not answer at recovery is asked again until it does (issue #368). A job whose machine's link drops
// while it runs is held on its lane the same way, and watched again once the link is back (issue #752).
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { TaskCount } from '../domain/task-count.ts';
import { finishBrief, MAX_FINISH_BRIEFS, type Job, type LaneId, type MachineSnapshot, type UnfinishedPullRequest } from '../domain/types.ts';
import { readJobRules, withAsks } from '../job-rules/index.ts';
import { repoJobRulesFor, withRepoJobRules } from '../job-rules/repo-rules.ts';
import { maskGitHubTokens, maskSecret } from '../secrets/mask.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, type EngineContext } from './context.ts';
import { agentSignIn, placeCredentials } from './credentials.ts';
import type { Claim } from './decision-step.ts';
import { recordOutcome } from './outcome.ts';
import { elsewhereBrief, freshStartBrief, recordPark, releaseParked, startsFresh } from './park.ts';
import { requeuePreempted } from './preemption.ts';
import { withCorrection } from './answers.ts';
import { forkResume } from './phase-shifts.ts';
import { nudgeCheck } from './nudge-check.ts';
import { runNotes } from './notes.ts';
import { moveLost, type Lost } from './lost-move.ts';

const PROGRESS_EVERY_MS = 500;

interface Progress { message?: string | undefined; tasks?: TaskCount | undefined }
/** How often a job waiting for its machine (after a restart, or a lost link) asks again whether its work is alive. */
const REACHABLE_EVERY_MS = 1000;

interface Running {
  controller: AbortController;
  /** Set by cancel(): the reason recorded on job.cancelled. */
  cancelReason?: string;
  /** A person's own words why (issue #1460), kept on job.cancelled beside the reason. */
  cancelNote?: string;
  /** Set by park() (issue #501): the job is parked once its executor has stepped aside, unless it finished meanwhile. */
  parking?: boolean;
  /** Set by drop() (issue #1662): another hopper holds the job now; this run writes no outcome. */
  dropped?: boolean;
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
  cancel(jobId: string, reason: string, note?: string): boolean;
  /** Abort a running job to park it (issue #501): its lane frees once its executor has stepped aside. False when it is not running here. */
  park(jobId: string): boolean;
  /** Abort everything for shutdown and wait up to `ms`. Nothing is written afterwards. */
  stopAll(ms: number): Promise<void>;
  /** The jobs this runner drives now (issue #1662). */
  driving(): string[];
  /** Another hopper took the job's lease (issue #1662): its run here ends as at a shutdown, and writes no outcome. */
  drop(jobId: string): boolean;
}

/** Abort reasons the executor reads from `ctx.signal.reason` (ports.ts ExecutionContext). */
const CANCEL = 'cancel';
const PARK = 'park';
const SHUTDOWN = 'shutdown';

/** A wait for the machine that ended the run: its work gone, or its machine away past the grace (issue #1569). */
type Unreached = ExecutionOutcome & { lost?: Lost };

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
async function completeOrFailed(c: EngineContext, job: Job, outcome: ExecutionOutcome, mayContinue: boolean, signal: AbortSignal): Promise<ExecutionOutcome | { finish: UnfinishedPullRequest }> {
  if (outcome.kind !== 'finished') return outcome;
  try {
    let v = await c.verdict(job);
    // A miss is asked again a moment later (issue #637): GitHub may not list a new pull request, or its new head, at once.
    if (!v.done && !('partlyDone' in v) && !(v.finish && mayContinue) && c.doneRecheckMs > 0) {
      await sleep(c.doneRecheckMs, undefined, { signal }).catch(() => {});
      if (!signal.aborted) v = await c.verdict(job);
    }
    if (v.done) return outcome;
    if ('partlyDone' in v) return { ...outcome, partlyDone: v.partlyDone };
    return v.finish && mayContinue ? { finish: v.finish } : { kind: 'failed', error: `not complete: ${v.why}` };
  } catch (e) {
    return { kind: 'failed', error: `could not confirm the work is complete: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function createRunner(c: EngineContext, cleanup: Cleanup): Runner {
  const running = new Map<string, Running>();

  /** A report leaves out what it does not change (issue #794): a message alone keeps the job's task count. */
  function progressReporter(jobId: string, laneId: LaneId) {
    let lastAt = -Infinity;
    let pending: Progress | undefined;
    const emit = (p: Progress): void => {
      lastAt = c.clock.now().getTime();
      pending = undefined;
      const message = p.message !== undefined ? maskGitHubTokens(p.message) : undefined;
      const data = { ...(message !== undefined ? { message } : {}), ...(p.tasks ? { tasks: p.tasks } : {}) };
      c.store.tx(() => {
        c.store.jobs.update(jobId, { ...(message !== undefined ? { progressMessage: message } : {}), ...(p.tasks ? { tasks: p.tasks } : {}) });
        c.store.events.append({ type: 'job.progressed', jobId, laneId, data });
      });
    };
    return {
      report(message?: string, tasks?: TaskCount): void {
        if (c.stopping() || (message === undefined && !tasks)) return;
        const p = { message: message ?? pending?.message, tasks: tasks ?? pending?.tasks };
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
   * starts. Issue #752: the same wait once a running job's machine link drops. Undefined once the job's
   * work is alive again and `job.reattached` is recorded; else the outcome that ends it, and how the machine was lost.
   */
  async function whenReachable(executor: Executor, job: Job, claim: Claim, machineId: string, signal: AbortSignal, why: 'daemon restart' | 'link restored'): Promise<Unreached | undefined> {
    const restart = why === 'daemon restart';
    const graceMs = restart ? c.reconnectGraceMs : c.linkGraceMs;
    const until = c.clock.now().getTime() + graceMs;
    for (;;) {
      const alive = await executor.canReattach!(job).catch(() => undefined);
      if (signal.aborted) return { kind: 'failed', error: 'aborted' };
      if (alive === false) return { kind: 'failed', error: restart ? 'interrupted by daemon restart' : `interrupted while the link to machine ${machineId} was down`, lost: 'gone' };
      if (alive) {
        if (!c.stopping()) c.store.events.append({ type: 'job.reattached', jobId: job.id, laneId: claim.laneId, data: { reason: why } });
        return undefined;
      }
      if (c.clock.now().getTime() >= until) {
        return { kind: 'failed', error: `machine ${machineId} did not reconnect within ${graceMs / 1000} s${restart ? ' after the daemon restart' : ''}`, lost: 'away' };
      }
      await sleep(REACHABLE_EVERY_MS, undefined, { signal }).catch(() => {});
    }
  }

  /**
   * Issue #752: the job's machine link dropped while its work was watched. The job is held — `running` on its lane,
   * `linkLost` on it — until its work is alive again (undefined) or the link grace runs out (the outcome that ends it).
   * A job held across a restart has `linkLost` still set: the reattach at recovery clears it.
   */
  async function holdThroughLinkLoss(executor: Executor, job: Job, claim: Claim, machineId: string, signal: AbortSignal): Promise<Unreached | undefined> {
    const now = c.clock.now().getTime();
    const linkLost = { machine: machineId, since: new Date(now).toISOString(), failsAt: new Date(now + c.linkGraceMs).toISOString() };
    if (c.stopping()) return { kind: 'failed', error: 'shutdown' };
    c.store.tx(() => {
      c.store.jobs.update(job.id, { linkLost });
      c.store.events.append({ type: 'job.link_lost', jobId: job.id, laneId: claim.laneId, data: linkLost });
    });
    console.warn(`job ${job.id}: the link to machine ${machineId} dropped; held up to ${c.linkGraceMs / 1000} s for it to come back`);
    return whenReachable(executor, job, claim, machineId, signal, 'link restored');
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
      // A preempted job runs again (issue #1525): its mark goes, and its minimum run time counts from now.
      const j = store.jobs.update(job.id, { status: 'running', startedAt: nowIso(c), preempted: undefined });
      store.events.append({ type: 'job.started', jobId: job.id, laneId: claim.laneId, data: { attempts: j.attempts } });
      return j;
    });
    const progress = progressReporter(job.id, claim.laneId);
    // A fork whose question was answered without it (issue #570) is told the answer first.
    // A person's correction of an earlier auto-answer (issue #632) goes in ahead of what it resumes with.
    const resumeWith = store.tx(() => withCorrection(c, started, forkResume(c, started, started.pendingAnswer === undefined ? undefined
      : started.parked?.elsewhere ? elsewhereBrief(started, started.pendingAnswer) : startsFresh(started) ? freshStartBrief(c, started, started.pendingAnswer) : started.pendingAnswer)));
    /** The agent's sign-ins given to this run: never in its outcome, as a tool's error may repeat its variables. */
    const given = new Set<string>();
    const contextOf = (j: Job, m: MachineSnapshot): ExecutionContext => ({
      // The job rules as they are at this start (issue #172): an edit reaches the next job. Then its repository's (issue #1472).
      job: j, laneId: claim.laneId, machine: m, signal: entry.controller.signal,
      jobRules: withAsks(withRepoJobRules(readJobRules(store.config), repoJobRulesFor(store.config, j.source?.repo)), j.spec, j.forkOf, j.followOn),
      // A login the job waits on (issue #476) goes to the logins, never into a question.
      logins: c.logins.forRun({ jobId: job.id, laneId: claim.laneId, machineId: m.id, run: job.spec.executor }, () => !c.stopping()),
      // The job acts through its source's connection (issue #214), its token kept current on its machine (issue #441).
      // `on`: the machine the job's work is on, when not the lane's (a job pod, issue #1283).
      // The agent's sign-in on a lane pod (issue #1287), from the user's vault: kept to mask it in the outcome.
      credentials: async (scratch, make = false, on = m) => {
        const placed = await placeCredentials(c, started, on, executor?.machineShell?.(on), scratch, make, (line) => progress.report(line));
        const signIn = await agentSignIn(c, started, on);
        for (const value of Object.values(signIn)) given.add(value);
        return { ...placed, ...signIn };
      },
      progress: (msg, tasks) => progress.report(msg, tasks),
      // Before a nudge (issue #627): the job's source, then what it waits on a person for.
      beforeNudge: () => nudgeCheck(c, j),
      // A person's notes (issue #997), read from the store each time: one sent mid-run goes in at the next turn boundary.
      notes: runNotes(c, job.id),
      saveState: (state) => { if (!c.stopping()) store.jobs.update(job.id, { executorState: state }); },
      workTree: (path) => { if (!c.stopping()) store.jobs.update(job.id, { workTree: path }); },
      agentSession: (id) => { if (!c.stopping()) store.jobs.update(job.id, { agentSession: id }); },
      // A missed heartbeat of its machine (issue #1569): its checkpoint now, while the machine may still answer.
      missedHeartbeat: () => c.checkpoints?.soon(job.id),
    });
    const masked = (outcome: ExecutionOutcome): ExecutionOutcome => {
      if (outcome.kind !== 'failed' || given.size === 0) return outcome;
      const mask = (text: string): string => [...given].reduce((t, v) => maskSecret(t, v, 'agent sign-in'), text);
      return { ...outcome, error: mask(outcome.error), ...(outcome.tail !== undefined ? { tail: mask(outcome.tail) } : {}) };
    };
    const guarded = async (go: () => Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
      try {
        return masked(await go());
      } catch (e) {
        return masked({ kind: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    };
    /** Set when the run ended on a wait for its machine (issue #1569): the job may resume rather than fail. */
    let lost: Lost | undefined;
    const unreached = (waited: Unreached | undefined): Unreached | undefined => { lost = waited?.lost; return waited; };
    /** Its machine link lost while it ran (issue #752): held, then watched again from its saved turn, as often as the link drops. */
    const attempt = async (go: () => Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
      lost = undefined;
      let outcome = await guarded(go);
      const { signal } = entry.controller;
      while (outcome.kind === 'failed' && outcome.linkLost && machine && executor?.canReattach && executor.reattach && !signal.aborted && !c.stopping()) {
        const waited = unreached(await holdThroughLinkLoss(executor, store.jobs.get(job.id) ?? started, claim, machine.id, signal));
        if (!c.stopping()) store.jobs.update(job.id, { linkLost: undefined });
        const now = store.jobs.get(job.id) ?? started;
        outcome = waited ?? await guarded(() => execute(executor, now, contextOf(now, machine), true, undefined));
      }
      return outcome;
    };
    let outcome = await attempt(async () => {
      const waited = machine && executor && launch === 'reattach-when-reachable'
        ? unreached(await whenReachable(executor, started, claim, machine.id, entry.controller.signal, 'daemon restart')) : undefined;
      if (started.linkLost && !c.stopping()) store.jobs.update(job.id, { linkLost: undefined });
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
        // Preempted (issue #1525): queued again at once, to resume where it stopped.
        if (parked.preempted) requeuePreempted(c, job.id);
        return;
      }
      if (entry.cancelReason !== undefined) break;
      const judged = await completeOrFailed(c, started, outcome, briefs < MAX_FINISH_BRIEFS && goOn !== undefined && !c.stopping() && !entry.parking, entry.controller.signal);
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
    // Shutdown, or another hopper took it (issue #1662): leave the job running in the store; that recovery decides its fate.
    if ((c.stopping() || entry.dropped) && entry.cancelReason === undefined) return;
    progress.flush();
    // Its machine lost (issue #1569): it resumes there in its kept work tree, or elsewhere from its checkpoint, when it can.
    if (lost && outcome.kind === 'failed' && entry.cancelReason === undefined && moveLost(c, job.id, claim.laneId, lost, outcome.error)) return;
    const recorded = recordOutcome(c, started, claim.laneId, outcome, entry.cancelReason === undefined ? undefined : { reason: entry.cancelReason, ...(entry.cancelNote ? { note: entry.cancelNote } : {}) }, machine);
    if (recorded.kind === 'question') c.questions.handle(recorded.questionId);
    else if (recorded.kind === 'report') c.reviews[recorded.review].handle(recorded.itemId);
    // Its own wait (issue #483) keeps its pane: nothing to clean up.
    else if (recorded.kind !== 'wait') await cleanup(job.id);
  }

  function launch(claim: Claim, how: Launch): void {
    // Another hopper drives it (issue #1662): its lease is that hopper's.
    if (!c.leases.take(claim.jobId)) { console.warn(`job ${claim.jobId}: another hopper holds its lease; not driven here`); return; }
    const entry: Running = { controller: new AbortController(), done: Promise.resolve() };
    running.set(claim.jobId, entry);
    entry.done = run(claim, entry, how)
      .catch((e) => console.error('job runner failed', claim.jobId, e))
      // Its lease ends with the run (issue #1662): another hopper may take the job at once.
      .finally(() => { if (running.get(claim.jobId) !== entry) return; running.delete(claim.jobId); try { c.leases.release(claim.jobId); } catch { /* the store closed: the lease ends by itself */ } });
  }

  return {
    start: (claim) => launch(claim, 'run'),
    reattach: (claim) => launch(claim, 'reattach'),
    reattachWhenReachable: (claim) => launch(claim, 'reattach-when-reachable'),
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
