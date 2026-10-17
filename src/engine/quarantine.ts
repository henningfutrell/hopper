// Quarantine (issue #655, part 2; design.md "Trust stamps"): a person's act on a job that has not ended. The job's stamp
// is signed `quarantined`, so the decider holds it and its proxy token opens no door of the hopper — a running job keeps
// its pane, but reaches no GitHub, git, vault, skill or step through the hopper. Only a person lifts it, to the level the
// job had before. Each is one event, with who acted.
import { TERMINAL_STATUSES, type ActingPerson, type Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

function live(c: EngineContext, id: string): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (TERMINAL_STATUSES.includes(job.status)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  return job;
}

/** In the tx: the job quarantined. 409 when it is quarantined already, or trust stamps are off. job.quarantined. */
export function recordQuarantine(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = live(c, id);
  const was = c.store.jobs.trustLevel(job);
  if (was === 'quarantined') throw new EngineError('conflict', `job ${id} is quarantined already`);
  const next = c.store.jobs.quarantine(id);
  if (next.stamp?.level !== 'quarantined') throw new EngineError('conflict', `job ${id} has no trust stamp to quarantine`);
  c.store.events.append({ type: 'job.quarantined', jobId: id, data: { ...(was ? { was } : {}), ...acting } });
  return next;
}

/** In the tx: the quarantine lifted, to the level the job had before. 409 when it is not quarantined. job.unquarantined. */
export function recordLiftQuarantine(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = live(c, id);
  if (c.store.jobs.trustLevel(job) !== 'quarantined') throw new EngineError('conflict', `job ${id} is not quarantined`);
  const next = c.store.jobs.liftQuarantine(id);
  c.store.events.append({ type: 'job.unquarantined', jobId: id, data: { level: next.stamp!.level, ...acting } });
  return next;
}
