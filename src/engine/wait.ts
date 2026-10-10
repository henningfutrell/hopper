// A job's own wait (issue #483, design.md "A job's own wait"): the job ended its turn with HOPPER_WAITING and is
// `waiting_on` what it named (outcome.ts). A person ends the wait here; its agent going on by itself ends it in
// pane-answers.ts.
import type { Job, JobWait } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What the job is told in its pane when a person ends its wait. */
export function waitEndedNote(wait: Pick<JobWait, 'for'> | undefined, note?: string): string {
  const what = wait ? ` what you waited for (${wait.for}) has happened` : ' what you waited for has happened';
  const said = note ? ` The person's note: ${note}` : '';
  return `[hopper] A person ended your wait:${what}.${said} Check it, then go on with the job.`;
}

/**
 * In the tx: a person ends the job's wait. It is queued again with the note pending, pinned to its machine (a pending
 * answer pins it, as for an answered question), and its claim types the note into its pane. `job.wait_ended`.
 */
export function recordEndWait(c: EngineContext, id: string, note?: string): Job {
  const { store } = c;
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (job.status !== 'waiting_on') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job on its own wait can have its wait ended`);
  const next = store.jobs.update(id, { status: 'queued', pendingAnswer: waitEndedNote(job.wait, note), wait: undefined, holdReason: undefined, waitReason: undefined });
  store.events.append({ type: 'job.wait_ended', jobId: id, data: { by: 'person', ...(note ? { note } : {}) } });
  return next;
}
