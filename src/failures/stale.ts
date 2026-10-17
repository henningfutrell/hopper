// When a failure waits on nothing any more (issues #1123, #1461), pure: what of its work item ends it, and the events
// after which the hand-offs look again (`handoffs.ts` `dismissStale`).
import type { EventType } from '../domain/types.ts';
import { mergedWhole } from '../domain/work-item-landing.ts';
import type { WorkItem } from '../domain/work-items.ts';

/** The events after which a failure may wait on nothing: a new job, its item's issue closed, its pull request merged or closed. */
export const ENDS_STALE: ReadonlySet<EventType> = new Set<EventType>([
  'job.queued', 'work_item.issue_closed', 'job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned', 'landing_batch.promoted',
]);

/**
 * Whether the item waits on no failure any more: its issue closed, it is done or dropped, or — while a person holds its
 * hand-off — its pull request merged as the whole item (not a culprit reverted from the landing branch) or closed without a
 * merge (issue #1461).
 */
export function itemEnded(item: WorkItem): boolean {
  if (item.issueState === 'closed' || item.state === 'done' || item.state === 'dropped') return true;
  return mergedWhole(item) || item.pullRequestState === 'closed' || item.pullRequestState === 'abandoned';
}
