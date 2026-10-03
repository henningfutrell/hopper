// The engine: gather → decide → apply, on a tick and on the events that change admission.
import { randomUUID } from 'node:crypto';
import type { EventType, JevMode } from '../domain/types.ts';
import { createClassifier } from './classifier.ts';
import { createCommands, type Commands } from './commands.ts';
import type { EngineContext, EngineOptions } from './context.ts';
import { decisionStep } from './decision-step.ts';
import { createQueries, type Queries } from './queries.ts';
import { recover } from './recovery.ts';
import { createRunner } from './runner.ts';
import { createSerial } from './serial.ts';

export { EngineError } from './errors.ts';
export type { EngineOptions } from './context.ts';
export type { MachineView, QueueView } from './queries.ts';

const SHUTDOWN_WAIT_MS = 5000;

/** Events that can change admission, so they wake the engine. */
const TRIGGERS: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'job.prioritized', 'job.approved', 'job.finished', 'job.failed', 'job.cancelled', 'jev.mode_changed',
]);

export interface Engine extends Commands, Queries {
  readonly advisorName: string;
  jevMode(): JevMode;
  /** Recover from a previous run, classify, take the first Decision, start the tick. */
  start(): void;
  /** Abort running executors (≤ 5 s) and stop deciding. The caller closes the store. */
  stop(): Promise<void>;
}

export function createEngine(o: EngineOptions): Engine {
  const { store } = o;
  if (store.settings.getJevMode() === undefined) store.settings.setJevMode(o.initialJevMode);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const serial = createSerial(async (reason) => {
    const claims = await decisionStep(c, reason, c.idGen());
    for (const claim of claims) runner.start(claim);
  }, (e) => console.error('decision failed', e));

  const c: EngineContext = {
    store, clock: o.clock, idGen: o.idGen ?? randomUUID, executors: o.executors, machines: o.machines,
    usage: o.usage, advisor: o.advisor, policy: o.policy,
    ...(o.fakeUsage ? { fakeUsage: o.fakeUsage } : {}),
    jevMode: () => store.settings.getJevMode() ?? o.initialJevMode,
    trigger: (reason) => serial.trigger(reason),
    stopping: () => stopping,
  };
  const runner = createRunner(c);
  const classifier = createClassifier(c);

  return {
    advisorName: o.advisor.name,
    jevMode: c.jevMode,
    ...createCommands(c, runner),
    ...createQueries(c),
    start() {
      recover(store);
      unsubscribe = store.events.subscribe((event) => {
        // Never decide inside append: schedule.
        if (event.type === 'job.queued' && event.jobId) {
          const jobId = event.jobId;
          setImmediate(() => classifier.classifyJob(jobId));
        }
        if (TRIGGERS.has(event.type)) setImmediate(() => c.trigger(event.type));
      });
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
