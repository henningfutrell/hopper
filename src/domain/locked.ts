// The locked entry (issue #355): what of the failed jobs stays in the queue.
import type { Job } from './types.ts';
import { isFailureOf, type WorkItem } from './work-items.ts';

/**
 * Who or what dismissed a locked entry (`job.dismissed`'s `by`): a person (`user`), or, by itself, nothing waits on it any
 * more (issue #1123): a newer job of its item took its place (`superseded`), or its item is closed at its source, done or
 * dropped (`item_closed`).
 */
export const DISMISSED_BY = ['user', 'superseded', 'item_closed'] as const;
export type DismissedBy = typeof DISMISSED_BY[number];

/**
 * A locked entry: a failed job of a source whose failure is still its work item's (`item`, the work-item ledger's, issue
 * #1067: failed, or handed to a person on it — not dismissed, not run again, its issue not closed). It stays in the queue,
 * is never run by itself and holds no lane, until it is run again or dismissed. A job of no source (from before phase 3)
 * cannot run again: never one.
 */
export function isLocked(job: Job, item: WorkItem | undefined): boolean {
  return job.status === 'failed' && job.source !== undefined && isFailureOf(item, job.id);
}
