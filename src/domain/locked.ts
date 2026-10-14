// The locked entry (issue #355): what of the failed jobs stays in the queue.
import type { Job } from './types.ts';
import { isFailureOf, type WorkItem } from './work-items.ts';

/**
 * A locked entry: a failed job of a source whose failure is still its work item's (`item`, the work-item ledger's, issue
 * #1067: failed, or handed to a person on it — not dismissed, not run again, its issue not closed). It stays in the queue,
 * is never run by itself and holds no lane, until it is run again or dismissed. A job of no source (from before phase 3)
 * cannot run again: never one.
 */
export function isLocked(job: Job, item: WorkItem | undefined): boolean {
  return job.status === 'failed' && job.source !== undefined && isFailureOf(item, job.id);
}
