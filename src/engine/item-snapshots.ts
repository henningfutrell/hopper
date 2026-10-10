// Item snapshots at intake (issue #662, design.md "Item snapshots"): the first job of an item records the text it ran
// with; every later job of the item runs that text, and a live text that hashes differently holds the job with a text
// change until a person keeps the original, accepts the new text (owner only: the route asks Access), or cancels it. A
// job that has not started is held the same way when its item changes while it waits.
import { newComments, textHash, type ItemSnapshot, type ItemText, type TextChange } from '../domain/item-snapshots.ts';
import type { SourceItem, SourceRef, UserStore } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type ActingPerson, type Job, type JobId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What the snapshot makes of an item about to become a job: the item to run, the text to record, or the change that holds it. */
export interface SnapshotGate { item: SourceItem; record?: ItemText; change?: TextChange }

const textOf = (s: ItemSnapshot): ItemText => ({ title: s.title, body: s.body, comments: s.comments });

/** The text the job last saw of its item: the change it holds, the live text whose original a person kept, else the snapshot. */
const seenBy = (job: Job | undefined, snapshot: ItemSnapshot): ItemText => job?.textChange?.to ?? job?.originalKept?.seen ?? textOf(snapshot);

/**
 * The item's live text: comments not read this time (a job not ended) are the ones last seen, so only an edit of its
 * title or body is a change then. Undefined: the source keeps no snapshot.
 */
function liveText(item: SourceItem, seen: ItemText | undefined): ItemText | undefined {
  if (!item.text) return undefined;
  const { title, body, comments } = item.text;
  return { title, body, comments: comments ?? seen?.comments ?? [] };
}

/** Whether `liveHash` is a text nothing deals with yet: not the snapshot, no change held for it, no original kept for it. */
const unhandled = (liveHash: string, snapshot: ItemSnapshot, job: Job | undefined): boolean =>
  liveHash !== snapshot.hash && job?.textChange?.liveHash !== liveHash && job?.originalKept?.liveHash !== liveHash;

function changeOf(snapshot: ItemSnapshot, live: ItemText, liveHash: string, accepted: SourceItem, at: string, item: SourceItem): TextChange {
  return {
    detectedAt: at, snapshotHash: snapshot.hash, liveHash, from: textOf(snapshot), to: live, edits: item.text?.edits ?? [],
    accepted: { title: accepted.title, body: accepted.body, prompt: accepted.prompt, env: accepted.env },
  };
}

/**
 * The snapshot of an item that becomes a new job: none yet → record the live text; the same hash → run it; another hash →
 * the job runs the snapshot's text, held with the change. A source that cannot render a text (`withText`) keeps no snapshot.
 */
export function gateItem(store: UserStore, item: SourceItem, source: SourceRef, at: string): SnapshotGate {
  if (!source.withText) return { item };
  const snapshot = store.itemSnapshots.get(item.key);
  const live = liveText(item, snapshot && textOf(snapshot));
  if (!live) return { item };
  if (!snapshot) return { item, record: live };
  const liveHash = textHash(live);
  const original = source.withText(item, textOf(snapshot));
  if (liveHash === snapshot.hash) return { item: original };
  return { item: original, change: changeOf(snapshot, live, liveHash, source.withText(item, live), at, item) };
}

/**
 * When the item's live text differs from its snapshot in a way not yet dealt with — no change held on `job` for that
 * text, no original kept for it —, the snapshot's time: what the sync loop asks the source's timeline for edits since.
 */
export function changedSince(store: UserStore, item: SourceItem, job: Job | undefined): string | undefined {
  const snapshot = store.itemSnapshots.get(item.key);
  const live = snapshot ? liveText(item, seenBy(job, snapshot)) : undefined;
  if (!snapshot || !live || !unhandled(textHash(live), snapshot, job)) return undefined;
  return snapshot.recordedAt;
}

/** In the tx: record the item's first snapshot at its new job. item.snapshot_recorded. */
export function recordSnapshot(c: EngineContext, job: Job, key: string, text: ItemText, reason: ItemSnapshot['reason']): ItemSnapshot {
  const snapshot = c.store.itemSnapshots.put({ key, ...text, hash: textHash(text), recordedAt: nowIso(c), reason, jobId: job.id });
  c.store.events.append({ type: 'item.snapshot_recorded', jobId: job.id, data: { key, hash: snapshot.hash, reason } });
  return snapshot;
}

/** In the tx: hold the job with the change. item.changed_since_snapshot: the hashes and who edited it, never the text. */
export function holdForChange(c: EngineContext, jobId: JobId, key: string, change: TextChange): Job {
  const job = c.store.jobs.update(jobId, { textChange: change });
  c.store.events.append({
    type: 'item.changed_since_snapshot', jobId,
    data: {
      key, snapshotHash: change.snapshotHash, liveHash: change.liveHash, editors: [...new Set(change.edits.map((e) => e.editor))],
      newComments: newComments(change.from, change.to).length,
    },
  });
  return job;
}

/**
 * A job not started whose item was offered again (issue #662): its item's text changed since the snapshot and no change
 * or kept original covers this text → held with the change. Never changes the job's text. True when it was held.
 */
export function refreshText(c: EngineContext, job: Job, item: SourceItem, source: SourceRef): boolean {
  if (!source.withText || job.attempts > 0 || (job.status !== 'queued' && job.status !== 'held')) return false;
  const snapshot = c.store.itemSnapshots.get(item.key);
  const live = snapshot ? liveText(item, seenBy(job, snapshot)) : undefined;
  if (!snapshot || !live) return false;
  const liveHash = textHash(live);
  if (!unhandled(liveHash, snapshot, job)) return false;
  holdForChange(c, job.id, item.key, changeOf(snapshot, live, liveHash, source.withText(item, live), nowIso(c), item));
  return true;
}

function held(c: EngineContext, id: string): Job & { textChange: TextChange } {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (TERMINAL_STATUSES.includes(job.status)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  if (!job.textChange || !job.source) throw new EngineError('conflict', `job ${id} is not held for a changed item`);
  return job as Job & { textChange: TextChange };
}

/** In the tx: Rerun the original. The job runs the snapshot's text, that live text holds it no more. item.original_kept. */
export function keepOriginal(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = held(c, id);
  const { liveHash, snapshotHash } = job.textChange;
  const next = c.store.jobs.update(id, { textChange: undefined, originalKept: { liveHash, at: nowIso(c), seen: job.textChange.to } });
  c.store.events.append({ type: 'item.original_kept', jobId: id, data: { key: job.source!.key, snapshotHash, liveHash, ...acting } });
  return next;
}

/**
 * In the tx: Accept the new text (owner only: the route asks Access first). The live text is the item's new snapshot, and
 * the job runs it. item.new_text_accepted, then item.snapshot_recorded.
 */
export function acceptNewText(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = held(c, id);
  const change = job.textChange;
  const { title, body, prompt, env } = change.accepted;
  c.store.jobs.respecify(id, { ...job.spec, goal: title, payload: { ...job.spec.payload, prompt, body, env } });
  const next = c.store.jobs.update(id, { textChange: undefined, originalKept: undefined });
  c.store.events.append({
    type: 'item.new_text_accepted', jobId: id,
    data: { key: job.source!.key, fromHash: change.snapshotHash, toHash: change.liveHash, editors: [...new Set(change.edits.map((e) => e.editor))], ...acting },
  });
  recordSnapshot(c, next, job.source!.key, change.to, 'accepted');
  return next;
}
