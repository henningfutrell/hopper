// What the HTTP edge asks of the engine. Each command validates, writes in one transaction,
// emits its event, and lets the event listener schedule the next Decision.
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { Job, JobSpec, JevMode, UsageReading } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import type { Runner } from './runner.ts';

const isTerminal = (job: Job): boolean => TERMINAL_STATUSES.includes(job.status);

function existing(c: EngineContext, id: string): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (isTerminal(job)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  return job;
}

export interface Commands {
  pushJob(spec: JobSpec): Job;
  cancel(id: string): Job;
  approve(id: string): Job;
  setJevMode(mode: JevMode): JevMode;
  setFakeUsage(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export function createCommands(c: EngineContext, runner: Runner): Commands {
  const { store } = c;
  return {
    pushJob(spec) {
      const executor = c.executors.get(spec.executor);
      if (!executor) {
        throw new EngineError('invalid', `unknown executor ${spec.executor} (known: ${c.executors.names().join(', ')})`);
      }
      const problem = executor.validate(spec.payload);
      if (problem) throw new EngineError('invalid', `invalid payload for executor ${spec.executor}: ${problem}`);
      const priority = Math.max(0, Math.min(100, spec.priority ?? 50));
      return store.tx(() => {
        const job = store.jobs.create(spec, priority);
        store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority } });
        return job;
      });
    },

    cancel(id) {
      const job = existing(c, id);
      if (job.status === 'claimed' || job.status === 'running') {
        // The runner ends it `cancelled` once the executor has stopped.
        if (runner.cancel(id)) return job;
      }
      return store.tx(() => {
        const next = store.jobs.update(id, { status: 'cancelled', finishedAt: nowIso(c) });
        store.events.append({ type: 'job.cancelled', jobId: id, data: { reason: `cancelled while ${job.status}` } });
        return next;
      });
    },

    approve(id) {
      existing(c, id);
      return store.tx(() => {
        const next = store.jobs.update(id, { approved: true });
        store.events.append({ type: 'job.approved', jobId: id, data: {} });
        return next;
      });
    },

    setJevMode(mode) {
      const from = c.jevMode();
      if (from === mode) return mode;
      store.tx(() => {
        store.settings.setJevMode(mode);
        store.events.append({ type: 'jev.mode_changed', data: { from, to: mode } });
      });
      return mode;
    },

    setFakeUsage(reading) {
      if (!c.fakeUsage) throw new EngineError('not_found', 'no fake usage source is configured');
      const readings = c.fakeUsage.set(reading);
      c.trigger('usage.changed');
      return readings;
    },
  };
}
