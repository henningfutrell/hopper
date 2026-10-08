// The engine: gather → decide → apply, on a tick and on the events that change admission.
import { randomUUID } from 'node:crypto';
import type { SourceHost } from '../domain/ports.ts';
import type { EventType } from '../domain/types.ts';
import { createAnswerHandlers, type AnswerHandlers } from './answers.ts';
import { createClassifier } from './classifier.ts';
import { createCleanups } from './cleanup.ts';
import { createCommands, type Commands } from './commands.ts';
import type { EngineContext, EngineOptions } from './context.ts';
import { decisionStep } from './decision-step.ts';
import { createPaneAnswers } from './pane-answers.ts';
import { createQueries, type Queries } from './queries.ts';
import { createQueueGateCommands, type QueueGateCommands } from './queue-gate.ts';
import { recover } from './recovery.ts';
import { createRunner } from './runner.ts';
import { createSerial } from './serial.ts';
import { createSourceHost } from './source-host.ts';
import { SWEEP_CHECK_MS, createSweep } from './sweep.ts';
import { renewCredentials } from './credentials.ts';

export { EngineError } from './errors.ts';
export type { EngineOptions } from './context.ts';
export type { MachineView, QueueView } from './queries.ts';

const SHUTDOWN_WAIT_MS = 5000;

/** Events that can change admission, so they wake the engine. A question frees a lane; an
 * answer or a close requeues a job; an expiry fails one; a source re-sort changes the order;
 * a respecified job may be pinned to another machine; a deferred cleanup that went through
 * frees a waiting job of its item (issue #371); parking frees a lane and a re-queue queues a job (issue #501); a
 * problem grouped or resolved holds or frees jobs (issue #509). */
const TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'job.prioritized', 'job.reprioritized', 'job.respecified', 'job.approved', 'job.finished', 'job.failed', 'job.cancelled',
  'question.asked', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
  'job.accepted', 'job.rejected', 'queue.ordered', 'queue.gate_changed', 'job.claimed_by_operator', 'job.cleaned_up',
  'job.parked', 'job.unparked', 'failure.grouped', 'failure.resolved',
]);

export interface Engine extends Commands, QueueGateCommands, Queries, AnswerHandlers {
  /** Registered executor names. */
  /** The runnable executors now: they follow the plugins config (issue #142). */
  readonly executorNames: string[];
  /** What the sync loop may do to the hopper (ingest, cancel, answer, refresh, setSourceState). */
  readonly sourceHost: SourceHost;
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
  let unsubscribe: (() => void) | undefined;

  const serial = createSerial(async (reason) => {
    const claims = await decisionStep(c, reason, c.idGen(), () => cleanups.due());
    for (const claim of claims) runner.start(claim);
  }, (e) => console.error('decision failed', e));

  const c: EngineContext = {
    store, clock: o.clock, idGen: o.idGen ?? randomUUID, executors: o.executors, machines: o.machines,
    usage: o.usage, router: o.router, queueSorter: o.queueSorter, routing: o.routing, policy: o.policy,
    questions: o.questions, logins: o.logins, maxQuestions: o.maxQuestions, keepPanes: o.keepPanes, reconnectGraceMs: o.reconnectGraceMs, notComplete: o.notComplete, credentials: o.credentials, problems: o.problems,
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

  return {
    get executorNames() { return o.executors.names(); },
    sourceHost: createSourceHost(c, commands),
    ...commands,
    ...createQueueGateCommands(c, (jobId) => { void cleanup(jobId); }),
    ...createQueries(c),
    ...createAnswerHandlers(c, cleanup),
    async start() {
      const recovered = await recover(c);
      // The reap of each job recovery ended, then the sweep of every machine (issue #410): what a hopper
      // that stopped mid-job, a lost pane or a reboot left, the reap of a pane closing never saw.
      void Promise.all(recovered.toClean.map((jobId) => cleanup(jobId))).then(() => sweep.run(true));
      sweepTimer = setInterval(() => { void sweep.run(); }, o.sweepCheckMs ?? SWEEP_CHECK_MS);
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
      timer = setInterval(() => {
        classifier.sweep();
        void paneAnswers.sweep();
        cleanups.retry();
        o.logins.sweep();
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
      unsubscribe?.();
      await runner.stopAll(SHUTDOWN_WAIT_MS);
      // In-flight classifications are not awaited: they write nothing once stopping.
      await serial.idle();
    },
  };
}
