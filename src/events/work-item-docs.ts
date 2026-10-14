// The work-item ledger's input events' docs (issue #1067, part 3): part of EVENT_DOCS (docs.ts), apart for its size.
import type { EventType } from '../domain/types.ts';

export const WORK_ITEM_EVENT_DOCS: Record<'job.pull_request_seen' | Extract<EventType, `work_item.${string}`>, string> = {
  'job.pull_request_seen': 'The follow saw what a followed pull request waits on change (issue #1067, part 3): `wait` is `draft` (to be marked ready), `conflicts` (a fix of its merge conflicts), `fixing_checks` (a fix of its failed checks), `checks_running` (its checks to pass) or `merge` (the merge). Recorded only when it differs from what the work-item ledger holds for the pull request; its work item waits on it.',
  'work_item.issue_closed': 'GitHub closed the issue of a work item (issue #1067, part 3): `key` is the item\'s source key, `reason` why it closed (`completed`, `not_planned`, `duplicate`). `via`: a GitHub delivery said it, or the ledger\'s fallback read of an item with no news for a while. Moves the item as a read of the issue does: an item no job or person acts on is done, or dropped when not planned.',
  'work_item.issue_reopened': 'GitHub reopened the issue of a work item (issue #1067, part 3): `key` is the item\'s source key; `via` as for `work_item.issue_closed`. The item stands where its events put it again.',
};
