// The critical flag (issue #2203, part 2; design.md "The critical job tracker"): a person marks any job critical, whatever
// its priority, so the critical job tracker shows it on every page; or clears the flag. A job that ended is not marked; its
// flag may still be cleared. The same flag again changes nothing. One event, with who acted.
import { TERMINAL_STATUSES, type ActingPerson, type Job } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** In the tx: the job's critical flag set or cleared. 404: no such job; 409: marking a job that ended. job.critical_flag_changed. */
export function recordCriticalFlag(c: EngineContext, id: string, critical: boolean, acting: ActingPerson): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if ((job.critical === true) === critical) return job;
  if (critical && TERMINAL_STATUSES.includes(job.status)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  const next = c.store.jobs.update(id, { critical: critical ? true : undefined });
  c.store.events.append({ type: 'job.critical_flag_changed', jobId: id, data: { critical, ...acting } });
  return next;
}
