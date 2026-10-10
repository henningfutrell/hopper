// A job's text change (issue #662), as its card reads it. The UI imports nothing of src/ at runtime, so the new comments
// are told apart here as the daemon does (src/domain/item-snapshots.ts `newComments`).
import type { ItemComment, TextChange } from '@/model/wire';

const keyOf = (c: ItemComment): string => `${c.author}\n${c.at}\n${c.body}`;

/** The assignee comments the live item has and the snapshot lacks. */
export function newCommentsOf(change: Pick<TextChange, 'from' | 'to'>): ItemComment[] {
  const seen = new Set(change.from.comments.map(keyOf));
  return change.to.comments.filter((c) => !seen.has(keyOf(c)));
}
