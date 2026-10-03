// The engine: gather → decide → apply, on a tick and on the events that change admission.
import { randomUUID } from 'node:crypto';
import type { SourceHost } from '../domain/ports.ts';
import type { EventType, RouterMode } from '../domain/types.ts';
import { createAnswerHandlers, type AnswerHandlers } from './answers.ts';
import { createClassifier } from './classifier.ts';
import { createCleanup } from './cleanup.ts';
import { createCommands, type Commands } from './commands.ts';
import type { EngineContext, EngineOptions } from './context.ts';
import { decisionStep } from './decision-step.ts';
import { createQueries, type Queries } from './queries.ts';
import { recover } from './recovery.ts';
import { createRunner } from './runner.ts';
import { createSerial } from './serial.ts';
import { createSourceHost } from './source-host.ts';

export { EngineError } from './errors.ts';
export type { EngineOptions } from './context.ts';
export type { MachineView, QueueView } from './queries.ts';

const SHUTDOWN_WAIT_MS = 5000;

/** Events that can change admission, so they wake the engine. A question frees a lane; an
 * answer requeues a job; an expiry fails one; a source re-sort changes the order. */
const TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'job.prioritized', 'job.reprioritized', 'job.approved', 'job.finished', 'job.failed', 'job.cancelled', 'router.mode_changed',
  'question.asked', 'question.answered', 'question.expired',
]);

export interface Engine extends Commands, Queries, AnswerHandlers {
  /** Registered executor names. */
  readonly executorNames: string[];
  /** What the sync loop may do to the hopper (ingest, cancel, answer, reprioritize, setSourceState). */
  readonly sourceHost: SourceHost;
  routerMode(): RouterMode;
  /** Recover from a previous run (jobs, then questions), ask the router, take the first Decision, start the tick. */
  start(): void;
  /** Abort running executors (≤ 5 s) and stop deciding. The caller closes the store. */
  stop(): Promise<void>;
}

export function createEngine(o: EngineOptions): Engine {
  const { store } = o;
  if (store.settings.getRouterMode() === undefined) store.settings.setRouterMode(o.initialRouterMode);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const serial = createSerial(async (reason) => {
    const claims = await decisionStep(c, reason, c.idGen());
    for (const claim of claims) runner.start(claim);
  }, (e) => console.error('decision failed', e));

  const c: EngineContext = {
    store, clock: o.clock, idGen: o.idGen ?? randomUUID, executors: o.executors, machines: o.machines,
    usage: o.usage, router: o.router, policy: o.policy,
    questions: o.questions, maxQuestions: o.maxQuestions, keepPanes: o.keepPanes,
    ...(o.fakeUsage ? { fakeUsage: o.fakeUsage } : {}),
    routerMode: () => store.settings.getRouterMode() ?? o.initialRouterMode,
    trigger: (reason) => serial.trigger(reason),
    stopping: () => stopping,
  };
  const cleanup = createCleanup(c);
  const runner = createRunner(c, cleanup);
  const classifier = createClassifier(c);
  const commands = createCommands(c, runner, cleanup);

  return {
    executorNames: o.executors.names(),
    sourceHost: createSourceHost(c, commands),
    routerMode: c.routerMode,
    ...commands,
    ...createQueries(c),
    ...createAnswerHandlers(c, cleanup),
    start() {
      for (const jobId of recover(c)) void cleanup(jobId);
      unsubscribe = store.events.subscribe((event) => {
        // Never decide inside append: schedule.
        if (event.type === 'job.queued' && event.jobId) {
          const jobId = event.jobId;
          setImmediate(() => classifier.classifyJob(jobId));
        }
        if (TRIGGERS.has(event.type)) setImmediate(() => c.trigger(event.type));
      });
      // Re-run open model tiers, re-arm human timers, expire overdue questions.
      o.questions.recover();
      timer = setInterval(() => {
        classifier.sweep();
        c.trigger('tick');
      }, o.tickMs);
      classifier.sweep();
      c.trigger('startup');
    },
    async stop() {
      stopping = true;
      serial.close();
      if (timer) clearInterval(timer);
      unsubscribe?.();
      await runner.stopAll(SHUTDOWN_WAIT_MS);
      // In-flight classifications are not awaited: they write nothing once stopping.
      await serial.idle();
    },
  };
}
