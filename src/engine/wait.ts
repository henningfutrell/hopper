// A job's own wait (issue #483, design.md "A job's own wait"): the job ended its turn with HOPPER_WAITING and is
// `waiting_on` what it named (outcome.ts). A person ends the wait here; its agent going on by itself ends it in
// pane-answers.ts. Issue #998: the hopper ends it here too, when an answer the job asked it for is ready (src/skills/waits.ts).
// Issue #1245: and when the event that settles what it waits on comes (`wakeOn`: a pull request merged or closed, a job
// ended, an item's issue closed, a question answered, a grant or an approval given or not), on that event, never a poll.
import type { Job, JobWait } from '../domain/types.ts';
import { waitOnLabel, waitsFor, type Settled } from '../domain/wait-on.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** Who ends a job's wait: a person, or the hopper with an answer the job asked it for (issue #998). */
export type WaitEnder = 'person' | 'hopper';

/** What the job is told in its pane when a person, or the hopper, ends its wait. */
export function waitEndedNote(wait: Pick<JobWait, 'for'> | undefined, note?: string, by: WaitEnder = 'person'): string {
  const waited = wait ? ` (${wait.for})` : '';
  if (by === 'hopper') {
    return `[hopper] The hopper ended your wait${waited}: the answer to a request you made is ready.${note ? ` The answer: ${note}` : ''} Check it, then go on with the job.`;
  }
  const said = note ? ` The person's note: ${note}` : '';
  return `[hopper] A person ended your wait: what you waited for${waited} has happened.${said} Check it, then go on with the job.`;
}

/**
 * In the tx: a person, or the hopper, ends the job's wait. It is queued again with the note pending, pinned to its machine (a pending
 * answer pins it, as for an answered question), and its claim types the note into its pane. `job.wait_ended`.
 */
export function recordEndWait(c: EngineContext, id: string, note?: string, by: WaitEnder = 'person', told?: (wait: JobWait | undefined) => string): Job {
  const { store } = c;
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (job.status !== 'waiting_on') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job on its own wait can have its wait ended`);
  const pendingAnswer = told ? told(job.wait) : waitEndedNote(job.wait, note, by);
  const next = store.jobs.update(id, { status: 'queued', pendingAnswer, wait: undefined, holdReason: undefined, waitReason: undefined });
  store.events.append({ type: 'job.wait_ended', jobId: id, data: { by, ...(note ? { note } : {}) } });
  return next;
}

/**
 * In the tx (issue #1245): `s` settled what some jobs wait on. Each job on its own wait on it is woken by the hopper,
 * told what happened. The woken jobs.
 */
export function wakeOn(c: EngineContext, s: Settled): string[] {
  const woken = c.store.jobs.list({ status: ['waiting_on'] }).filter((j) => waitsFor(j, s));
  for (const j of woken) {
    recordEndWait(c, j.id, s.note, 'hopper', (w) => `[hopper] The hopper ended your wait (${w?.on ? waitOnLabel(w.on) : w?.for ?? 'what you waited on'}): ${s.note}. Check it, then go on with the job.`);
  }
  return woken.map((j) => j.id);
}
