// The engine: gather → decide → apply, on a tick and on the events that change admission.
import { randomUUID } from 'node:crypto';
import type { SourceHost } from '../domain/ports.ts'; import type { SagaStepContext } from '../sagas/coordinator.ts';
import { settledBy } from '../domain/wait-on.ts';
import { keptTreeOf, keptWorkOf, REVIEW_KINDS, REVIEW_SECTIONS, WORK_EVENTS, type ActingPerson, type Discarding, type EventType, type Job, type MachineSnapshot, type ReviewKind } from '../domain/types.ts';
import { createAnswerHandlers, type AnswerHandlers } from './answers.ts';
import { autoPark } from './auto-park.ts';
import { createSignedOutMove } from './signed-out-move.ts';
import { BUSY_MOVE_EVERY_MS, createBusyMove } from './busy-move.ts';
import { preemptRunning } from './preemption.ts';
import { createClassifier } from './classifier.ts';
import { createCleanups } from './cleanup.ts';
import { createCommands, type Commands } from './commands.ts';
import type { EngineContext, EngineOptions } from './context.ts';
import { credentialHeldOf, decisionStep } from './decision-step.ts';
import { releaseWait } from './wait-release.ts';
import { createPaneAnswers } from './pane-answers.ts';
import { askFor, createReviewHandlers, type ReviewHandlers } from './reviews.ts';
import { createQueries, type Queries } from './queries.ts';
import { createQueueGateCommands, type QueueGateCommands } from './queue-gate.ts';
import { recover } from './recovery.ts'; import { liftLost } from './lost-move.ts'; import { createJobLeases, createLeaseKeeper } from './leases.ts';
import { createRunner } from './runner.ts';
import { createSerial } from './serial.ts';
import { createSourceHost } from './source-host.ts';
import { createUsageLimitCommands, type UsageLimitCommands } from './usage-limits.ts';
import { createPriorityLanes, type PriorityLanes } from './priority-lanes.ts';
import { DISCOVER_CHECK_MS, createBlastRadius, type BlastRadius } from './blast-radius.ts';
import { SWEEP_CHECK_MS, createSweep } from './sweep.ts';
import { createPassLeases } from './pass-leases.ts';
import { CHECKPOINT_CHECK_MS, createCheckpoints, type Checkpoints } from './checkpoints.ts'; import { pauseForBudget } from './token-budget.ts';
import { createPhaseShifts, type PhaseShifts } from './phase-shifts.ts';
import { createLaneTuning, type LaneTuningService } from './lane-tuning.ts';
import { createMachineDrains, drainedMachines, type MachineDrains } from './machine-drains.ts'; import { createSandboxHostSetting, sandboxHostMachines, type SandboxHostSetting } from './sandbox-host.ts';
import { createReachHolds } from './reach-holds.ts'; import { createLaneHealth } from './lane-health.ts';
import { createPlacementPicks } from './lane-calls.ts';
import { createTrustChecks } from './trust-checks.ts';
import { createKindChecks } from './kind-checks.ts';

import { EngineError } from './errors.ts';
import { createMissedWakes, wakeOn } from './wait.ts';
import { createWaitChecks } from './wait-checks.ts';
export { EngineError };
export type { EngineOptions } from './context.ts';
export type { MachineView, QueueView } from './queries.ts';
export type { PriorityLanes, PriorityLaneSettingsPatch } from './priority-lanes.ts';
export type { BlastRadius, BlastRadiusSettingsPatch } from './blast-radius.ts';
export type { PhaseShifts, PhaseShiftSettingsPatch, ShiftRequest, ShiftResult } from './phase-shifts.ts';
export type { LaneTuningPatch, LaneTuningService } from './lane-tuning.ts';
export type { Checkpoints } from './checkpoints.ts';

const SHUTDOWN_WAIT_MS = 5000;

/** Events that can change admission, so they wake the engine. A question frees a lane; an
 * answer or a close requeues a job; an expiry fails one; a source re-sort changes the order;
 * a respecified job may be pinned to another machine; a deferred cleanup that went through
 * frees a waiting job of its item (issue #371); parking frees a lane and a re-queue queues a job (issue #501); a
 * problem grouped or resolved holds or frees jobs (issue #509); new usage limits change every lane cap (issue #522);
 * new priority lane settings change which lanes default jobs may take (issue #535); a proposal or a research report frees
 * a lane, and one sent back or accepted on to the next section requeues its job (issues #537, #543); a discovery that
 * changed a machine, new blast-radius settings and a job let through the gate change which machines a job may take
 * (issue #542); a fork queued or a job switched from its question re-queued changes the queue (issue #548); a template
 * saved or removed, a profile approved and a vault secret set or removed change a template's rating, so its boxes' (issue #605); a read-only check ended or asked for again changes whether its boxes take a job (issue #716); a lane recommendation applied or undone changes a machine's lanes (issue #688). */
const TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'job.prioritized', 'job.reprioritized', 'job.respecified', 'job.approved', 'job.finished', 'job.failed', 'job.cancelled',
  'question.asked', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
  'job.accepted', 'job.rejected', 'queue.ordered', 'queue.gate_changed', 'job.claimed_by_operator', 'job.cleaned_up',
  'job.parked', 'job.unparked', 'job.continued', 'failure.grouped', 'failure.resolved', 'usage.limits_changed', 'priority_lanes.settings_changed',
  ...REVIEW_KINDS.flatMap((k) => (['submitted', 'revision_requested', 'accepted'] as const).map((s) => `${REVIEW_SECTIONS[k].prefix}.${s}` as EventType)),
  'machine.discovered', 'blast_radius.settings_changed', 'vault.approved', 'vault.revoked', 'job.gate_passed', 'job.forked',
  'template.saved', 'template.removed', 'template.profile_approved', 'template.checked', 'template.check_requested', 'vault.secret_set', 'vault.secret_removed',
  'lanes.applied', 'lanes.undone',
]);

export interface Engine extends Commands, QueueGateCommands, UsageLimitCommands, Queries, AnswerHandlers, ReviewHandlers {
  /** Ask a job that has not started for a review section's special job: a proposal (issue #537), research (issue #543). */
  askFor(kind: ReviewKind, id: string): Job;
  /** Registered executor names. */
  /** The runnable executors now: they follow the plugins config (issue #142). */
  readonly executorNames: string[];
  /** Of those, the ones that can park a job (issue #530): the UI offers Park only for their jobs. */
  readonly parkingExecutors: string[];
  /** Whether a failed job's own agent session can resume (issue #551): its executor parks, and it recorded a session and its pane state. */
  resumable(job: Job): boolean;
  /**
   * Whether an ended job reopens in its kept work tree (issue #1472 part 2): its executor parks, or reopens with no park
   * (`Executor.reopensKept`, a print-mode agent's), and it recorded its state. Its own agent session resumes when
   * `resumable`, else a fresh session starts there.
   */
  reopens(job: Job): boolean;
  /** Of those, the ones that run the research and proposal loop (issue #548): only their jobs may shift phase from a question. */
  readonly reviewingExecutors: string[];
  /** Phase shifts from a question (issue #548): fork or switch into research or a proposal, and their settings. */
  readonly phaseShifts: PhaseShifts;
  /** What the sync loop may do to the hopper (ingest, cancel, answer, refresh, setSourceState). */
  readonly sourceHost: SourceHost;
  /** The priority lanes and the high-priority threshold (issue #535): settings, choice, every lane's figures. */
  readonly priorityLanes: PriorityLanes;
  /** Each machine's discovery and blast radius, the gate and the actor machines (issue #542). */
  readonly blastRadius: BlastRadius;
  /** Lane tuning (issue #688): every machine's lane recommendation, recorded; an admin's apply, dismiss and undo; each machine's settings. */
  readonly laneTuning: LaneTuningService;
  /** Drained machines (issue #1511): a person drains or undrains a machine; every machine the engine lists carries it. */
  readonly machineDrains: MachineDrains;
  /** The sandbox host (issue #2272): the machines the user's sandboxes start on. */
  readonly sandboxHost: SandboxHostSetting;
  /** Job checkpoints (issue #921): a pass every minute takes those due; a park takes one. */
  readonly checkpoints: Checkpoints;
  /**
   * Discard an ended job's kept work (issue #1010): its scratch dir removed on its machine whatever it holds (`Sweep.discard`).
   * Answers before the removal, which runs after (issue #1194); `discarding` says how it goes.
   */
  discardWork(jobId: string, by: ActingPerson): Promise<{ jobId: string; paths: string[] }>;
  /** A discard's removal under way, or why it failed (issue #1194). */
  discarding(jobId: string): Discarding | undefined;
  /**
   * The `job-move` saga's step (issue #1569): ends the agent the job left on the machine it moved off, its pane named by
   * `left`. Nothing when the job or its executor's `endLeft` is gone. Rejects while that machine cannot be reached.
   */
  endLeft(jobId: string, left: Job['executorState']): Promise<void>;
  /** A step of the `job-run` saga (issue #1662, job-run.ts), done by this user's runner. Rejects when the run is left here. */
  jobRunStep(name: string, s: SagaStepContext): Promise<Record<string, unknown>>;
  /** A person keeps or removes a leftover the sweep listed on a machine (issue #1116, `Sweep.decideLeftover`). */
  decideLeftover(machineId: string, path: string, decision: 'keep' | 'remove', by: ActingPerson): Promise<{ machineId: string; path: string; decision: 'keep' | 'remove' }>;
  /** Recover from a previous run (jobs — reattaching live ones, waiting for machines not reachable yet —, then questions), ask the router, take the first Decision, start the tick. */
  start(): Promise<void>;
  /** Abort running executors (≤ 5 s) and stop deciding. The caller closes the store. */
  stop(): Promise<void>;
  /** Ask for a Decision: something it reads changed outside the engine (the failure settings, issue #509). Coalesces. */
  trigger(reason: string): void;
}

export function createEngine(o: EngineOptions): Engine {
  const { store } = o;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let autoParking = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  let discoverTimer: NodeJS.Timeout | undefined;
  let checkpointTimer: NodeJS.Timeout | undefined;
  let checkpointing = false;
  let unsubscribe: (() => void) | undefined;

  const serial = createSerial(async (reason) => {
    const { claims, preempts, releases } = await decisionStep(c, reason, c.idGen(), () => cleanups.due(), priorityLanes, blastRadius, laneTuning.expected, placementPicks, preStart);
    for (const claim of claims) runner.start(claim);
    for (const jobId of preempts) preemptRunning(c, runner, jobId);
    for (const jobId of releases) void releaseWait(c, jobId);
  }, (e) => console.error('decision failed', e));

  const reachHolds = createReachHolds(o.clock); const laneHealth = createLaneHealth(o.clock);
  const c: EngineContext = {
    store, clock: o.clock, idGen: o.idGen ?? randomUUID, executors: o.executors, machines: laneHealth.source(reachHolds.source(sandboxHostMachines(drainedMachines(o.machines, { store }), { store }))), reachHolds, laneHealth, configuredMachines: o.configuredMachines ?? (() => undefined),
    usage: o.usage, router: o.router, queueSorter: o.queueSorter, routing: o.routing, policy: o.policy,
    questions: o.questions, reviews: o.reviews, logins: o.logins, maxQuestions: o.maxQuestions, keepPanes: o.keepPanes, reconnectGraceMs: o.reconnectGraceMs, linkGraceMs: o.linkGraceMs ?? 600000, doneRecheckMs: o.doneRecheckMs ?? 0, doneReadRetryMs: o.doneReadRetryMs ?? 5000, ownCommandGraceMs: o.ownCommandGraceMs ?? 300000, verdict: o.verdict, overAtSource: o.overAtSource ?? (async () => undefined), credentialRequests: o.credentialRequests ?? (() => []), jobProxy: o.jobProxy ?? (() => undefined), agentSignIn: o.agentSignIn ?? (async () => ({ none: true as const })), deliveredSecrets: o.deliveredSecrets ?? (async () => []), traceContext: o.traceContext ?? (() => ({})), boxRadius: o.boxRadius ?? (() => undefined), problems: o.problems, sandboxesHeld: o.sandboxesHeld ?? (() => []),
    machineLanes: o.machineLanes ?? (() => Promise.reject(new EngineError('conflict', 'a machine\'s lanes cannot be set here'))),
    jevFirst: o.jevFirst ?? { decide: () => Promise.resolve({ asked: false }) },
    ...(o.fakeUsage ? { fakeUsage: o.fakeUsage } : {}), ...(o.jobMoves ? { jobMoves: o.jobMoves } : {}), ...(o.waitReads ? { waitReads: o.waitReads } : {}), ...(o.jobRuns ? { jobRuns: o.jobRuns } : {}),
    trigger: (reason) => serial.trigger(reason),
    stopping: () => stopping,
    leases: createJobLeases({ store, ...(o.jobLeaseMs ? { leaseMs: o.jobLeaseMs } : {}) }),
  };
  const cleanups = createCleanups(c);
  const cleanup = cleanups.run;
  const runner = createRunner(c, cleanup);
  const classifier = createClassifier(c);
  const commands = createCommands(c, runner, cleanups);
  // A person's act another hopper relayed (issue #1662): a cancel as that hopper's would be; a park parks the run here, and
  // a preempted job not run here loses its mark.
  const leases = createLeaseKeeper(c, runner, cleanup, (jobId, act) => {
    if (act.kind === 'cancel') { commands.cancel(jobId, act.reason, act.note); return; }
    if (runner.park(jobId)) return;
    console.warn(`hopper: job ${jobId}: another hopper relayed its park, but it does not run here`);
    preemptRunning(c, runner, jobId, false);
  });
  const paneAnswers = createPaneAnswers(c, (claim) => runner.reattach(claim));
  const sweep = createSweep(c);
  const checkpoints = createCheckpoints(c, undefined, (jobId) => pauseForBudget(c, jobId, (id) => runner.park(id) || c.leases.relay(id, { kind: 'park' })));
  c.checkpoints = checkpoints;
  // The signed-out move (issue #1211): a job held on a not-signed-in question goes on at a signed-in machine.
  const signedOutMove = createSignedOutMove(c);
  let moving = false;
  // The busy-machine move (issue #1977): a job resuming on a full machine goes on at one with room, after a short wait.
  const busyMove = createBusyMove(c);
  let busyMoving = false;
  let busyMovedAt = 0;
  const priorityLanes = createPriorityLanes(c);
  const blastRadius = createBlastRadius(c);
  const phaseShifts = createPhaseShifts(c);
  // Decider calls in lane tuning (issue #688): Jev reads every lane's reliability (issue #535) and never decides for a gated machine; nor for a machine the credential check holds (issue #1467).
  const laneCalls = { gated: (id: string) => blastRadius.gates(id), reliability: async () => (await priorityLanes.view()).lanes, credentialHeld: (m: MachineSnapshot) => credentialHeldOf(c, [m]).length > 0 };
  const laneTuning = createLaneTuning(c, laneCalls);
  const placementPicks = createPlacementPicks(c, { ...laneCalls, expected: (job) => laneTuning.expected(job) });
  // Jev's trust check (issue #655 part 4): a job's stamp checked before it starts, the point active.
  // And its kind (issue #655, `intake-kind`): research or a proposal before the work, the point active.
  const preStart = { trust: createTrustChecks(c), kind: createKindChecks(c) };
  // Several hosts on one database (issues #1627, #1662): each pass over every job or machine runs on its lease's holder.
  const passes = createPassLeases(o.lease);
  // Issue #1571: a wake a stop lost, at start, and on each tick.
  const missedWakes = createMissedWakes(c);
  // Issue #1694: each job's own wait gets its wait check, tested on each tick when due.
  const waitChecks = createWaitChecks(c);
  const wakeMissed = (): void => {
    if (!passes.held('missedWakes')) return;
    try {
      if (store.tx(() => missedWakes.run()).length > 0) c.trigger('job.wait_ended');
    } catch (e) {
      console.error('hopper: waking the jobs whose wait a missed event settled failed', e);
    }
  };

  return {
    get executorNames() { return o.executors.names(); },
    get parkingExecutors() { return o.executors.names().filter((n) => o.executors.get(n)?.park !== undefined); },
    resumable: (job) => job.agentSession !== undefined && job.executorState !== undefined && o.executors.get(job.spec.executor)?.park !== undefined,
    // With no state recorded (issue #1472), an executor that parks reopens in the job worktree its kept work names.
    reopens: (job) => { const ex = o.executors.get(job.spec.executor); return job.executorState !== undefined ? ex?.park !== undefined || ex?.reopensKept === true : ex?.park !== undefined && keptTreeOf(keptWorkOf(store.events.recent(1, [...WORK_EVENTS], job.id))[0]) !== undefined; },
    get reviewingExecutors() { return o.executors.names().filter((n) => o.executors.get(n)?.reviews === true); },
    phaseShifts,
    sourceHost: createSourceHost(c, commands),
    priorityLanes,
    blastRadius,
    laneTuning,
    machineDrains: createMachineDrains(c), sandboxHost: createSandboxHostSetting(c),
    checkpoints,
    discardWork: (jobId, by) => sweep.discard(jobId, by),
    discarding: (jobId) => sweep.discarding(jobId),
    decideLeftover: (machineId, path, decision, by) => sweep.decideLeftover(machineId, path, decision, by),
    async endLeft(jobId, left) {
      const job = store.jobs.get(jobId);
      const executor = job ? o.executors.get(job.spec.executor) : undefined;
      if (job && executor?.endLeft) await executor.endLeft(job, left);
      if (!stopping) liftLost(c, jobId);
    },
    jobRunStep: (name, s) => runner.step(name, s),
    ...commands,
    ...createQueueGateCommands(c, (jobId) => { void cleanup(jobId); }),
    ...createUsageLimitCommands(c),
    ...createQueries(c, (id) => sweep.disk(id), (id) => sweep.leftovers(id)),
    ...createAnswerHandlers(c, cleanup),
    ...createReviewHandlers(c, cleanup, (jobId, reason) => commands.cancel(jobId, reason)),
    askFor: (kind, id) => askFor(c, kind, id),
    async start() {
      const recovered = await recover(c);
      runner.restarted(recovered.onSaga);
      // Each cleanup a record says is due (issue #1570) — of a job recovery ended, or one whose end a stop cut off from
      // its cleanup — and each deferred one (issue #371), then the sweep of every machine (issue #410): what a hopper
      // that stopped mid-job, a lost pane or a reboot left, the reap of a pane closing never saw.
      // On several hosts on one database (issues #1627, #1662), only the sweep lease's holder sweeps; a host that takes it
      // sweeps every machine. Only the cleanups lease's holder does the owed cleanups, at its start and when it takes the lease.
      const sweepIfHeld = (): Promise<void> => { const h = passes.hold('sweep'); return h.held ? sweep.run(h.taken) : Promise.resolve(); };
      const resumeIfHeld = (): Promise<void> => { const h = passes.hold('cleanups'); return h.taken ? cleanups.resume() : Promise.resolve(); };
      void resumeIfHeld().then(sweepIfHeld);
      sweepTimer = setInterval(() => { void sweepIfHeld(); }, o.sweepCheckMs ?? SWEEP_CHECK_MS);
      // Discovery (issue #542): each machine again every `everyMinutes`; one that comes online, at the next Decision.
      discoverTimer = setInterval(() => { if (passes.held('discovery')) void blastRadius.run(); }, DISCOVER_CHECK_MS);
      // Checkpoints (issue #921): one pass at a time; a pass still reading machines skips this one.
      checkpointTimer = setInterval(() => {
        if (checkpointing || !passes.held('checkpoints')) return;
        checkpointing = true;
        void checkpoints.run().catch((e: unknown) => console.error('hopper: checkpoints failed', e)).finally(() => { checkpointing = false; });
      }, CHECKPOINT_CHECK_MS);
      for (const claim of recovered.reattach) runner.reattach(claim);
      for (const claim of recovered.awaiting) runner.reattachWhenReachable(claim);
      leases.start();
      unsubscribe = store.events.subscribe((event) => {
        // Never decide inside append: schedule.
        if (event.type === 'job.queued' && event.jobId) {
          const jobId = event.jobId;
          setImmediate(() => classifier.classifyJob(jobId));
          // Its status is read now, before a Decision can claim it (issue #688, `job-machine`).
          placementPicks.ask(jobId, event.at);
        }
        if ((event.type === 'job.claimed' || event.type === 'job.cancelled') && event.jobId) placementPicks.forget(event.jobId);
        if (TRIGGERS.has(event.type)) setImmediate(() => c.trigger(event.type));
        // A job waiting on something goes on when the event that settles it comes (issue #1245): on the event, never a poll.
        const settled = settledBy(event);
        if (settled) {
          setImmediate(() => {
            if (stopping) return;
            try {
              if (store.tx(() => wakeOn(c, settled)).length > 0) c.trigger('job.wait_ended');
            } catch (e) {
              console.error(`hopper: waking the jobs waiting on what ${event.type} settled failed`, e);
            }
          });
        }
      });
      // Restart open questions at the answer stage, re-arm human timers, expire overdue ones.
      o.questions.recover();
      for (const k of REVIEW_KINDS) o.reviews[k].recover();
      wakeMissed();
      timer = setInterval(() => {
        wakeMissed();
        leases.tick();
        if (passes.held('classifier')) classifier.sweep();
        if (passes.held('paneAnswers')) void paneAnswers.sweep();
        void waitChecks.run();
        // Each host tries again the cleanups it deferred; a host that takes the cleanups lease does every one owed.
        cleanups.retry();
        void resumeIfHeld();
        o.logins.sweep();
        o.questions.sweep();
        for (const k of REVIEW_KINDS) o.reviews[k].sweep();
        placementPicks.sweep();
        // Auto-park (issue #650): one pass at a time; a pass still ending panes skips this tick.
        if (!autoParking && passes.held('autoPark')) {
          autoParking = true;
          void autoPark(c).catch((e: unknown) => console.error('hopper: auto-park failed', e)).finally(() => { autoParking = false; });
        }
        if (!moving && passes.held('signedOutMove')) {
          moving = true;
          void signedOutMove().catch((e: unknown) => console.error('hopper: the signed-out move failed', e)).finally(() => { moving = false; });
        }
        if (!busyMoving && c.clock.now().getTime() - busyMovedAt >= BUSY_MOVE_EVERY_MS && passes.held('busyMove')) {
          busyMoving = true;
          busyMovedAt = c.clock.now().getTime();
          void busyMove().catch((e: unknown) => console.error('hopper: the busy-machine move failed', e)).finally(() => { busyMoving = false; });
        }
        c.trigger('tick');
      }, o.tickMs);
      if (passes.held('classifier')) classifier.sweep();
      c.trigger('startup');
    },
    trigger: (reason) => { if (!stopping) c.trigger(reason); },
    async stop() {
      stopping = true;
      serial.close();
      if (timer) clearInterval(timer);
      if (sweepTimer) clearInterval(sweepTimer);
      if (discoverTimer) clearInterval(discoverTimer);
      if (checkpointTimer) clearInterval(checkpointTimer);
      unsubscribe?.();
      await runner.stopAll(SHUTDOWN_WAIT_MS);
      leases.stop();
      // A discard under way is a record (issue #1570), done again after the next start: the stop waits for it a while only.
      await Promise.race([sweep.removals(), new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS).unref())]);
      // In-flight classifications are not awaited: they write nothing once stopping.
      await serial.idle();
    },
  };
}
