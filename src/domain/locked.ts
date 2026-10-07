// The locked entry (issue #355): what of the failed jobs stays in the queue.
import type { Job } from './types.ts';

/**
 * A locked entry: a failed job of a source, the newest of its item (`newest`: the newest job of its
 * source key), not dismissed. It stays in the queue, is never run by itself and holds no lane, until it
 * is run again or dismissed. A job of no source (from before phase 3) cannot run again: never one.
 */
export function isLocked(job: Job, newest: Job | undefined): boolean {
  return job.status === 'failed' && job.dismissedAt === undefined && job.source !== undefined && newest?.id === job.id;
}
