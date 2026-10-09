// The engine: gather → decide → apply, on a tick and on the events that change admission.
import { randomUUID } from 'node:crypto';
import type { SourceHost } from '../domain/ports.ts';
import { REVIEW_KINDS, REVIEW_SECTIONS, type EventType, type Job, type ReviewKind } from '../domain/types.ts';
import { createAnswerHandlers, type AnswerHandlers } from './answers.ts';
import { createClassifier } from './classifier.ts';
import { createCleanups } from './cleanup.ts';
import { createCommands, type Commands } from './commands.ts';
import type { EngineContext, EngineOptions } from './context.ts';
import { decisionStep } from './decision-step.ts';
import { createPaneAnswers } from './pane-answers.ts';
import { askFor, createReviewHandlers, type ReviewHandlers } from './reviews.ts';
import { createQueries, type Queries } from './queries.ts';
import { createQueueGateCommands, type QueueGateCommands } from './queue-gate.ts';
import { recover } from './recovery.ts';
import { createRunner } from './runner.ts';
import { createSerial } from './serial.ts';
import { createSourceHost } from './source-host.ts';
import { createUsageLimitCommands, type UsageLimitCommands } from './usage-limits.ts';
import { createPriorityLanes, type PriorityLanes } from './priority-lanes.ts';
import { DISCOVER_CHECK_MS, createBlastRadius, type BlastRadius } from './blast-radius.ts';
import { SWEEP_CHECK_MS, createSweep } from './sweep.ts';
import { createPhaseShifts, type PhaseShifts } from './phase-shifts.ts';
import { renewCredentials } from './credentials.ts';

export { EngineError } from './errors.ts';
export type { EngineOptions } from './context.ts';
export type { MachineView, QueueView } from './queries.ts';
export type { PriorityLanes, PriorityLaneSettingsPatch } from './priority-lanes.ts';
export type { BlastRadius, BlastRadiusSettingsPatch } from './blast-radius.ts';
export type { PhaseShifts, PhaseShiftSettingsPatch, ShiftRequest, ShiftResult } from './phase-shifts.ts';

const SHUTDOWN_WAIT_MS = 5000;

/** Events that can change admission, so they wake the engine. A question frees a lane; an
 * answer or a close requeues a job; an expiry fails one; a source re-sort changes the order;
 * a respecified job may be pinned to another machine; a deferred cleanup that went through
 * frees a waiting job of its item (issue #371); parking frees a lane and a re-queue queues a job (issue #501); a
 * problem grouped or resolved holds or frees jobs (issue #509); new usage limits change every lane cap (issue #522);
 * new priority lane settings change which lanes default jobs may take (issue #535); a proposal or a research report frees
 * a lane, and one sent back or accepted on to the next section requeues its job (issues #537, #543); a discovery that
 * changed a machine, new blast-radius settings and a job let through the gate change which machines a job may take
 * (issue #542); a fork queued or a job switched from its question re-queued changes the queue (issue #548). */
const TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'job.prioritized', 'job.reprioritized', 'job.respecified', 'job.approved', 'job.finished', 'job.failed', 'job.cancelled',
  'question.asked', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
  'job.accepted', 'job.rejected', 'queue.ordered', 'queue.gate_changed', 'job.claimed_by_operator', 'job.cleaned_up',
  'job.parked', 'job.unparked', 'job.continued', 'failure.grouped', 'failure.resolved', 'usage.limits_changed', 'priority_lanes.settings_changed',
  ...REVIEW_KINDS.flatMap((k) => (['submitted', 'revision_requested', 'accepted'] as const).map((s) => `${REVIEW_SECTIONS[k].prefix}.${s}` as EventType)),
  'machine.discovered', 'blast_radius.settings_changed', 'job.gate_passed', 'job.forked',
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
  /** Recover from a previous run (jobs — reattaching live ones, waiting for machines not reachable yet —, then questions), ask the router, take the first Decision, start the tick. */
  start(): Promise<void>;
  /** Abort running executors (≤ 5 s) and stop deciding. The caller closes the store. */
  stop(): Promise<void>;
  /** Ask for a Decision: something it reads changed outside the engine (the failure settings, issue #509). Coalesces. */
  trigger(reason: string): void;
  /** The connection renewed its token (issue #441): every job in flight has its credential files rewritten on its machine. */
  renewCredentials(): Promise<void>;
}

export function createEngine(o: EngineOptions): Engine {
  const { store } = o;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let discoverTimer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const serial = createSerial(async (reason) => {
    const claims = await decisionStep(c, reason, c.idGen(), () => cleanups.due(), priorityLanes, blastRadius);
    for (const claim of claims) runner.start(claim);
  }, (e) => console.error('decision failed', e));

  const c: EngineContext = {
    store, clock: o.clock, idGen: o.idGen ?? randomUUID, executors: o.executors, machines: o.machines,
    usage: o.usage, router: o.router, queueSorter: o.queueSorter, routing: o.routing, policy: o.policy,
    questions: o.questions, reviews: o.reviews, logins: o.logins, maxQuestions: o.maxQuestions, keepPanes: o.keepPanes, reconnectGraceMs: o.reconnectGraceMs, notComplete: o.notComplete, credentials: o.credentials, jobProxy: o.jobProxy ?? (() => undefined), problems: o.problems,
    ...(o.fakeUsage ? { fakeUsage: o.fakeUsage } : {}),
    trigger: (reason) => serial.trigger(reason),
    stopping: () => stopping,
  };
  const cleanups = createCleanups(c);
  const cleanup = cleanups.run;
  const runner = createRunner(c, cleanup);
  const classifier = createClassifier(c);
  const commands = createCommands(c, runner, cleanups);
  const paneAnswers = createPaneAnswers(c, (claim) => runner.reattach(claim));
  const sweep = createSweep(c);
  const priorityLanes = createPriorityLanes(c);
  const blastRadius = createBlastRadius(c);
  const phaseShifts = createPhaseShifts(c);

  return {
    get executorNames() { return o.executors.names(); },
    get parkingExecutors() { return o.executors.names().filter((n) => o.executors.get(n)?.park !== undefined); },
    resumable: (job) => job.agentSession !== undefined && job.executorState !== undefined && o.executors.get(job.spec.executor)?.park !== undefined,
    get reviewingExecutors() { return o.executors.names().filter((n) => o.executors.get(n)?.reviews === true); },
    phaseShifts,
    sourceHost: createSourceHost(c, commands),
    priorityLanes,
    blastRadius,
    ...commands,
    ...createQueueGateCommands(c, (jobId) => { void cleanup(jobId); }),
    ...createUsageLimitCommands(c),
    ...createQueries(c),
    ...createAnswerHandlers(c, cleanup),
    ...createReviewHandlers(c, cleanup),
    askFor: (kind, id) => askFor(c, kind, id),
    async start() {
      const recovered = await recover(c);
      // The reap of each job recovery ended, then the sweep of every machine (issue #410): what a hopper
      // that stopped mid-job, a lost pane or a reboot left, the reap of a pane closing never saw.
      void Promise.all(recovered.toClean.map((jobId) => cleanup(jobId))).then(() => sweep.run(true));
      sweepTimer = setInterval(() => { void sweep.run(); }, o.sweepCheckMs ?? SWEEP_CHECK_MS);
      // Discovery (issue #542): each machine again every `everyMinutes`; one that comes online, at the next Decision.
      discoverTimer = setInterval(() => { void blastRadius.run(); }, DISCOVER_CHECK_MS);
      // Deferred before this start (issue #371): tried again now, and on every tick.
      cleanups.retry();
      for (const claim of recovered.reattach) runner.reattach(claim);
      for (const claim of recovered.awaiting) runner.reattachWhenReachable(claim);
      unsubscribe = store.events.subscribe((event) => {
        // Never decide inside append: schedule.
        if (event.type === 'job.queued' && event.jobId) {
          const jobId = event.jobId;
          setImmediate(() => classifier.classifyJob(jobId));
        }
        if (TRIGGERS.has(event.type)) setImmediate(() => c.trigger(event.type));
      });
      // Restart open questions at the answer stage, re-arm human timers, expire overdue ones.
      o.questions.recover();
      for (const k of REVIEW_KINDS) o.reviews[k].recover();
      timer = setInterval(() => {
        classifier.sweep();
        void paneAnswers.sweep();
        cleanups.retry();
        o.logins.sweep();
        o.questions.sweep();
        for (const k of REVIEW_KINDS) o.reviews[k].sweep();
        c.trigger('tick');
      }, o.tickMs);
      classifier.sweep();
      c.trigger('startup');
    },
    trigger: (reason) => { if (!stopping) c.trigger(reason); },
    renewCredentials: () => (stopping ? Promise.resolve() : renewCredentials(c, (line) => console.warn(line))),
    async stop() {
      stopping = true;
      serial.close();
      if (timer) clearInterval(timer);
      if (sweepTimer) clearInterval(sweepTimer);
      if (discoverTimer) clearInterval(discoverTimer);
      unsubscribe?.();
      await runner.stopAll(SHUTDOWN_WAIT_MS);
      // In-flight classifications are not awaited: they write nothing once stopping.
      await serial.idle();
    },
  };
}
