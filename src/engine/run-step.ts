// The `run` step of the `job-run` saga (issue #1662, job-run.ts): the executor runs the job to its outcome — from its
// opened pane, as a fresh run, a resume, or a reattach —, held through a lost machine link (issue #752), and asked to go
// on with the brief that finishes its pull request (issue #626). Tried again (its hopper stopped, or this one started),
// it watches the work its first try left, once its machine answers (issue #368): the task is never sent twice.
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExecutionOutcome, Executor } from '../domain/ports.ts';
import { finishBrief, MAX_FINISH_BRIEFS, type Job, type UnfinishedPullRequest } from '../domain/types.ts';
import { withCorrection } from './answers.ts';
import type { EngineContext } from './context.ts';
import { cancelOf, contextOf, guarded, left, machineOf, progressOf, runJob, type JobRunData, type RunEntry, type TakenUp } from './job-run.ts';
import type { Lost } from './lost-move.ts';
import { elsewhereBrief, freshStartBrief, startsFresh } from './park.ts';
import { forkResume } from './phase-shifts.ts';
import { NO_WAY_PANE, noWayMove } from './no-way-move.ts';

/** How often a job waiting for its machine (after a restart, or a lost link) asks again whether its work is alive. */
const REACHABLE_EVERY_MS = 1000;

/** A wait for the machine that ended the run: its work gone, or its machine away past the grace (issue #1569). */
type Unreached = ExecutionOutcome & { lost?: Lost };

/** `answer`: the pending answer as the executor gets it — for a parked job starting fresh, wrapped in its brief (issue #530). */
async function execute(executor: Executor | undefined, job: Job, ctx: Parameters<Executor['run']>[0], reattach: boolean, answer: string | undefined): Promise<ExecutionOutcome> {
  if (!executor) return { kind: 'failed', error: `executor ${job.spec.executor} is not registered` };
  if (reattach) return executor.reattach ? executor.reattach(ctx) : { kind: 'failed', error: `executor ${executor.name} cannot reattach` };
  if (answer === undefined) return executor.run(ctx);
  if (!executor.resume) return { kind: 'failed', error: `executor ${executor.name} cannot resume` };
  return executor.resume(ctx, answer);
}

/** How many times a done job's source is read before the job fails on the read error (issue #2235): the first and two more. */
const DONE_READ_TRIES = 3;

/**
 * The verdict, read again on a read error (issue #2235): a connect timeout, a busy service or a rate limit is not a miss.
 * After `doneReadRetryMs`, then twice as long; the last read error, or an abort, throws.
 */
async function readVerdict(c: EngineContext, job: Job, signal: AbortSignal): Promise<Awaited<ReturnType<EngineContext['verdict']>>> {
  for (let tried = 1; ; tried++) {
    try {
      return await c.verdict(job);
    } catch (e) {
      if (tried >= DONE_READ_TRIES || signal.aborted) throw e;
      console.warn(`job ${job.id}: could not read its source to check the work (try ${tried} of ${DONE_READ_TRIES}): ${e instanceof Error ? e.message : String(e)}`);
      await sleep(c.doneReadRetryMs * 2 ** (tried - 1), undefined, { signal }).catch(() => {});
      if (signal.aborted) throw e;
    }
  }
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
    let v = await readVerdict(c, job, signal);
    // A miss is asked again a moment later (issue #637): GitHub may not list a new pull request, or its new head, at once.
    if (!v.done && !('partlyDone' in v) && !(v.finish && mayContinue) && c.doneRecheckMs > 0) {
      await sleep(c.doneRecheckMs, undefined, { signal }).catch(() => {});
      if (!signal.aborted) v = await readVerdict(c, job, signal);
    }
    if (v.done) return outcome;
    if ('partlyDone' in v) return { ...outcome, partlyDone: v.partlyDone };
    return v.finish && mayContinue ? { finish: v.finish } : { kind: 'failed', error: `not complete: ${v.why}` };
  } catch (e) {
    return { kind: 'failed', error: `could not confirm the work is complete: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Why the run waits for its machine: this hopper or its own started (issue #368), or the machine link came back (issue #752). */
type WaitWhy = TakenUp | 'link restored';

/**
 * Issue #368: a client target dials in, an ssh target answers, some seconds after the daemon starts. Issue #752: the same
 * wait once a running job's machine link drops. Undefined once the job's work is alive again and `job.reattached` is
 * recorded; else the outcome that ends it, and how the machine was lost.
 */
async function whenReachable(c: EngineContext, executor: Executor, job: Job, d: JobRunData, machineId: string, signal: AbortSignal, why: WaitWhy): Promise<Unreached | undefined> {
  const restart = why !== 'link restored';
  const graceMs = restart ? c.reconnectGraceMs : c.linkGraceMs;
  const until = c.clock.now().getTime() + graceMs;
  const cut = why === 'daemon restart' ? 'interrupted by daemon restart' : why === 'its hopper stopped' ? 'interrupted: its hopper stopped' : `interrupted while the link to machine ${machineId} was down`;
  for (;;) {
    const alive = await executor.canReattach!(job).catch(() => undefined);
    if (signal.aborted) return { kind: 'failed', error: 'aborted' };
    if (alive === false) return { kind: 'failed', error: cut, lost: 'gone' };
    if (alive) {
      if (!c.stopping()) c.store.events.append({ type: 'job.reattached', jobId: job.id, laneId: d.laneId, data: { reason: why } });
      return undefined;
    }
    if (c.clock.now().getTime() >= until) {
      return { kind: 'failed', error: `machine ${machineId} did not reconnect within ${graceMs / 1000} s${why === 'daemon restart' ? ' after the daemon restart' : ''}`, lost: 'away' };
    }
    await sleep(REACHABLE_EVERY_MS, undefined, { signal }).catch(() => {});
  }
}

/**
 * Issue #752: the job's machine link dropped while its work was watched. The job is held — `running` on its lane,
 * `linkLost` on it — until its work is alive again (undefined) or the link grace runs out (the outcome that ends it).
 * A job held across a restart has `linkLost` still set: the reattach at recovery clears it.
 */
async function holdThroughLinkLoss(c: EngineContext, executor: Executor, job: Job, d: JobRunData, machineId: string, signal: AbortSignal): Promise<Unreached | undefined> {
  const now = c.clock.now().getTime();
  const linkLost = { machine: machineId, since: new Date(now).toISOString(), failsAt: new Date(now + c.linkGraceMs).toISOString() };
  if (c.stopping()) return { kind: 'failed', error: 'shutdown' };
  c.store.tx(() => {
    c.store.jobs.update(job.id, { linkLost });
    c.store.events.append({ type: 'job.link_lost', jobId: job.id, laneId: d.laneId, data: linkLost });
  });
  console.warn(`job ${job.id}: the link to machine ${machineId} dropped; held up to ${c.linkGraceMs / 1000} s for it to come back`);
  return whenReachable(c, executor, job, d, machineId, signal, 'link restored');
}

/**
 * The run step. `takenUp`: why it is tried again (a first try: undefined) — then an executor safe to run again from
 * scratch is queued again, and any other watches its work once its machine answers. Throws when the run is left here
 * (this hopper stops, or another one holds the job): the step is done again, with no outcome written.
 */
export async function runStep(c: EngineContext, e: RunEntry, d: JobRunData, takenUp: TakenUp | undefined): Promise<Partial<JobRunData>> {
  const { store } = c;
  const started = runJob(c, d);
  if (d.gone || d.outcome || d.unreached !== undefined || !started) return {};
  // Cancelled before it ran (its pane opening): the task is not sent; the end's cleanup closes the pane.
  if (e.cancelReason !== undefined) return { outcome: { kind: 'failed', error: 'aborted' }, ...cancelOf(e) };
  const executor = c.executors.get(started.spec.executor);
  if (takenUp && executor?.idempotent !== false) return { requeue: takenUp };
  const machine = await machineOf(c, d.laneId);
  // A pane the `pane` step opened: the task in it is sent and watched (the executor's reattach).
  const how = takenUp ? 'reattach-when-reachable' : d.session ? 'reattach' : d.launch;
  // A fork whose question was answered without it (issue #570) is told the answer first.
  // A person's correction of an earlier auto-answer (issue #632) goes in ahead of what it resumes with.
  const resumeWith = takenUp ? undefined : store.tx(() => withCorrection(c, started, forkResume(c, started, started.pendingAnswer === undefined ? undefined
    : started.parked?.elsewhere ? elsewhereBrief(started, started.pendingAnswer) : startsFresh(started) ? freshStartBrief(c, started, started.pendingAnswer) : started.pendingAnswer)));
  const { signal } = e.controller;
  /** Set when the run ended on a wait for its machine (issue #1569): the job may resume rather than fail. */
  let lost: Lost | undefined;
  const unreached = (waited: Unreached | undefined): Unreached | undefined => { lost = waited?.lost; return waited; };
  /** Its machine link lost while it ran (issue #752): held, then watched again from its saved turn, as often as the link drops. */
  const attempt = async (go: () => Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
    lost = undefined;
    let outcome = await guarded(e, go);
    while (outcome.kind === 'failed' && outcome.linkLost && machine && executor?.canReattach && executor.reattach && !signal.aborted && !c.stopping()) {
      const waited = unreached(await holdThroughLinkLoss(c, executor, store.jobs.get(started.id) ?? started, d, machine.id, signal));
      if (!c.stopping()) store.jobs.update(started.id, { linkLost: undefined });
      const now = store.jobs.get(started.id) ?? started;
      outcome = waited ?? await guarded(e, () => execute(executor, now, contextOf(c, e, d, now, machine), true, undefined));
    }
    return outcome;
  };
  let outcome = await attempt(async () => {
    const reachable = executor?.canReattach ? executor : undefined;
    const waited = machine && reachable && how === 'reattach-when-reachable'
      ? unreached(await whenReachable(c, reachable, started, d, machine.id, signal, takenUp ?? 'daemon restart')) : undefined;
    if (started.linkLost && !c.stopping()) store.jobs.update(started.id, { linkLost: undefined });
    if (!machine) return { kind: 'failed', error: `machine of lane ${d.laneId} is not attached` };
    if (!waited && how === 'reattach-when-reachable' && !reachable) return unreached({ kind: 'failed', error: takenUp === 'its hopper stopped' ? 'interrupted: its hopper stopped' : 'interrupted by daemon restart', lost: 'gone' })!;
    const now = store.jobs.get(started.id) ?? started;
    return waited ?? await execute(executor, now, contextOf(c, e, d, now, machine), how !== 'run', resumeWith);
  });
  /** The job goes on in its own session, told `text`; undefined: its executor cannot resume it. */
  const resume = executor?.resume?.bind(executor);
  const goOn = machine && resume ? (j: Job, text: string) => resume(contextOf(c, e, d, j, machine), text) : undefined;
  // Its own pull request left with merge conflicts or as a draft (issue #626): the job goes on in its own session with
  // the fixed brief that finishes it, a few times at most, before it is judged as any other.
  for (let briefs = 0; ; briefs += 1) {
    // Parked mid-turn (issue #501): the executor left its pane as it was; the checkpoint step ends it, the work tree and
    // session kept. A job that ended done meanwhile is recorded as any other.
    if (e.parking && e.cancelReason === undefined && outcome.kind !== 'finished' && !left(c, e)) { progressOf(c, e, d).flush(); return { park: true }; }
    if (e.cancelReason !== undefined) break;
    const judged = await completeOrFailed(c, started, outcome, briefs < MAX_FINISH_BRIEFS && goOn !== undefined && !c.stopping() && !e.parking, signal);
    if (!('finish' in judged)) { outcome = judged; break; }
    const { finish } = judged;
    const now = store.tx(() => {
      store.events.append({ type: 'job.finish_briefed', jobId: started.id, laneId: d.laneId, data: { pullRequest: finish.pullRequest, step: finish.step } });
      // A parked, continued or released job's run (issues #501, #551, #2303) reopened its session already: the brief types into that pane.
      const j = store.jobs.get(started.id) ?? started;
      return j.parked || j.continued || j.waitReleased ? store.jobs.update(started.id, { parked: undefined, continued: undefined, waitReleased: undefined }) : j;
    });
    outcome = await attempt(() => goOn!(now, finishBrief(finish)));
  }
  // Shutdown, or another hopper took it (issue #1662): the job stays running in the store; the step is done again.
  if (left(c, e)) throw new Error('the run is left here: this hopper stops, or another one holds the job');
  // Its machine out of reach of the hopper at its start (issue #1920): queued again by the end step. So is a job that
  // resumes elsewhere whose pane there had no way to the hopper (issue #2355), its machine held.
  const noWay = outcome.kind === 'failed' && outcome.noWayToHopper && machine && e.unreached === undefined ? noWayMove(c, store.jobs.get(started.id) ?? started, machine.id, NO_WAY_PANE) : undefined;
  // What its pane showed stays on its timeline: the evidence of why that machine gave it no way to the hopper.
  if (noWay !== undefined && machine) { c.reachHolds?.hold(machine.id, NO_WAY_PANE); e.unreached = noWay; progressOf(c, e, d).report(outcome.kind === 'failed' ? outcome.error : noWay); progressOf(c, e, d).flush(); }
  if (e.unreached !== undefined && e.cancelReason === undefined) return { unreached: e.unreached };
  // Its pane gone when its run was taken up (issue #1569): the move says why, as a restart's recovery does.
  const lostWhy = takenUp && lost === 'gone' ? { lostWhy: `its pane was gone after ${takenUp === 'daemon restart' ? 'a daemon restart' : 'its hopper stopped'}` } : {};
  return { outcome, ...(lost ? { lost } : {}), ...lostWhy, ...cancelOf(e) };
}
