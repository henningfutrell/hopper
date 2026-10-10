// Item snapshots (issue #662): the text an item's first job ran with — its title, body and the assignee comments the
// job saw —, and its SHA-256 hash. Every later job of the item runs that text; a live item whose text hashes
// differently holds its job until a person decides (a text change). Pure.
import { createHash } from 'node:crypto';

/** One comment an item's job sees (the assignee's own, on GitHub). */
export interface ItemComment { author: string; at: string; body: string }

/** An item's text: what its job runs. */
export interface ItemText { title: string; body: string; comments: ItemComment[] }

/** How a snapshot came to be: at the item's first job, from its first job's spec by the migration, or a person accepted new text. */
export const SNAPSHOT_REASONS = ['intake', 'backfill', 'accepted'] as const;
export type SnapshotReason = typeof SNAPSHOT_REASONS[number];

/** The approved text of one source item, by its key. */
export interface ItemSnapshot extends ItemText {
  key: string;
  hash: string;
  recordedAt: string;
  reason: SnapshotReason;
  /** The job it was recorded at. */
  jobId?: string;
}

/** Who edited an item since its snapshot, as its source's timeline says: what (its title or body), who, and when. */
export interface ItemEdit { what: 'title' | 'body'; editor: string; at: string }

/**
 * A job held because its item's text changed since the snapshot (issue #662). `from` is the snapshot's text, `to` the
 * live text; `accepted` is the job's text if a person accepts the new text. Each is shown on the card; no event carries them.
 */
export interface TextChange {
  detectedAt: string;
  snapshotHash: string;
  liveHash: string;
  from: ItemText;
  to: ItemText;
  /** Who edited it since the snapshot, when the source could say; empty when it could not. */
  edits: ItemEdit[];
  /** The job's text with the new text: what Accept the new text gives its spec. */
  accepted: { title: string; body: string; prompt: string; env: Record<string, string> };
}

/** A person kept the original text of a changed item (Rerun the original): that live text (`seen`) holds the job no more. */
export interface OriginalKept { liveHash: string; at: string; seen: ItemText }

/** The SHA-256 of an item's text, hex: title, body and each comment, in order. */
export function textHash(t: ItemText): string {
  const canonical = JSON.stringify([t.title, t.body, t.comments.map((c) => [c.author, c.at, c.body])]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The comments of `to` that `from` lacks: the new ones since the snapshot. */
export function newComments(from: ItemText, to: ItemText): ItemComment[] {
  const seen = new Set(from.comments.map((c) => `${c.author}\n${c.at}\n${c.body}`));
  return to.comments.filter((c) => !seen.has(`${c.author}\n${c.at}\n${c.body}`));
}
