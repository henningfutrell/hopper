// A comment ends the job's own wait (issue #2159): the job view says the job was woken by a comment, with its link, until
// the job waits again. Pure.
import type { DomainEvent } from './wire.ts';

/** The link of the comment that ended the job's last own wait, from its events newest first; undefined when none did, or it waits again. */
export function wokenByComment(events: readonly DomainEvent[]): string | undefined {
  const last = events.find((e) => e.type === 'job.waiting' || e.type === 'job.wait_ended');
  const comment = last?.type === 'job.wait_ended' ? (last.data as { comment?: unknown }).comment : undefined;
  return typeof comment === 'string' ? comment : undefined;
}
