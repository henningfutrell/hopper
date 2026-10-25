// Item snapshots at intake (issue #662, design.md "Item snapshots"): the first job of an item records the text it ran
// with; every later job of the item runs that text, and a live title or body that differs holds the job with a text
// change until a person keeps the original, accepts the new text (owner only: the route asks Access), or cancels it. A
// job that has not started is held the same way when its item changes while it waits. New comments alone hold nothing
// (issue #747): a status note or a bot's update does not change what the item asks. A started job runs the text it
// started with; an edit of its item that a sync sees lowers its trust stamp to `untrusted` (issue #655 part 7), so gate 2
// asks a person before it gives the job more, until a person approves its trust. Each such edit is `item.edit_seen`
// (issue #2775 part 3), a text edit on the job's kept delivery track.
import { newComments, sameAsk, textHash, type ItemSnapshot, type ItemText, type TextChange } from '../domain/item-snapshots.ts';
import type { SourceItem, SourceRef, UserStore } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type ActingPerson, type Job, type JobId } from '../domain/types.ts';
import { EDIT_REASON } from '../domain/trust-stamp.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What the snapshot makes of an item about to become a job: the item to run, the text to record, or the change that holds it. */
export interface SnapshotGate { item: SourceItem; record?: ItemText; change?: TextChange }

const textOf = (s: ItemSnapshot): ItemText => ({ title: s.title, body: s.body, comments: s.comments });

/** The text the job last saw of its item: the change it holds, the live text whose original a person kept, else the snapshot. */
const seenBy = (job: Job | undefined, snapshot: ItemSnapshot): ItemText => job?.textChange?.to ?? job?.editSeen?.seen ?? job?.originalKept?.seen ?? textOf(snapshot);

/**
 * The item's live text: comments not read this time (a job not ended) are the ones last seen, so only an edit of its
 * title or body is a change then. Undefined: the source keeps no snapshot.
 */
function liveText(item: SourceItem, seen: ItemText | undefined): ItemText | undefined {
  if (!item.text) return undefined;
  const { title, body, comments } = item.text;
  return { title, body, comments: comments ?? seen?.comments ?? [] };
}

/**
 * Whether `live` asks what nothing deals with yet: not the snapshot's title and body, no change held for them, no original
 * kept for them, no edit seen for them after the start. Its comments are not compared (issue #747).
 */
const unhandled = (live: ItemText, snapshot: ItemSnapshot, job: Job | undefined): boolean =>
  ![textOf(snapshot), job?.textChange?.to, job?.originalKept?.seen, job?.editSeen?.seen].some((t) => t && sameAsk(t, live));

function changeOf(snapshot: ItemSnapshot, live: ItemText, accepted: SourceItem, at: string, item: SourceItem): TextChange {
  return {
    detectedAt: at, snapshotHash: snapshot.hash, liveHash: textHash(live), from: textOf(snapshot), to: live, edits: item.text?.edits ?? [],
    accepted: { title: accepted.title, body: accepted.body, prompt: accepted.prompt, env: accepted.env },
  };
}

/**
 * The snapshot of an item that becomes a new job: none yet → record the live text; the same title and body → run it, new
 * comments or not; another title or body → the job runs the snapshot's text, held with the change. A source that cannot
 * render a text (`withText`) keeps no snapshot.
 */
export function gateItem(store: UserStore, item: SourceItem, source: SourceRef, at: string): SnapshotGate {
  if (!source.withText) return { item };
  const snapshot = store.itemSnapshots.get(item.key);
  const live = liveText(item, snapshot && textOf(snapshot));
  if (!live) return { item };
  if (!snapshot) return { item, record: live };
  const original = source.withText(item, textOf(snapshot));
  if (sameAsk(live, snapshot)) return { item: original };
  return { item: original, change: changeOf(snapshot, live, source.withText(item, live), at, item) };
}

/**
 * When the item's live text differs from its snapshot in a way not yet dealt with — no change held on `job` for that
 * text, no original kept for it —, the snapshot's time: what the sync loop asks the source's timeline for edits since.
 */
export function changedSince(store: UserStore, item: SourceItem, job: Job | undefined): string | undefined {
  const snapshot = store.itemSnapshots.get(item.key);
  const live = snapshot ? liveText(item, seenBy(job, snapshot)) : undefined;
  if (!snapshot || !live || !unhandled(live, snapshot, job)) return undefined;
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
  if (!unhandled(live, snapshot, job)) return false;
  holdForChange(c, job.id, item.key, changeOf(snapshot, live, source.withText(item, live), nowIso(c), item));
  return true;
}

/**
 * A started job whose item was offered again (issue #655 part 7): its item's title or body changed since the snapshot, and
 * no edit seen covers this text → its trust stamp drops to `untrusted` (`job.trust_lowered`, by the edit), and the text
 * is seen, `item.edit_seen`. The job goes on with the text it started with. True when the job changed.
 */
export function refreshEdit(c: EngineContext, job: Job, item: SourceItem, source: SourceRef): boolean {
  if (!source.withText || (job.attempts === 0 && (job.status === 'queued' || job.status === 'held'))) return false;
  const snapshot = c.store.itemSnapshots.get(item.key);
  const live = snapshot ? liveText(item, seenBy(job, snapshot)) : undefined;
  if (!snapshot || !live || !unhandled(live, snapshot, job)) return false;
  const from = c.store.jobs.trustLevel(job);
  const lowered = c.store.jobs.edited(job.id);
  const liveHash = textHash(live);
  c.store.jobs.update(job.id, { editSeen: { liveHash, at: nowIso(c), seen: live } });
  c.store.events.append({
    type: 'item.edit_seen', jobId: job.id,
    data: { key: item.key, fromHash: textHash(seenBy(job, snapshot)), toHash: liveHash, editors: [...new Set((item.text?.edits ?? []).map((e) => e.editor))] },
  });
  if (lowered?.stamp && from) {
    c.store.events.append({ type: 'job.trust_lowered', jobId: job.id, data: { from, to: lowered.stamp.level, reason: EDIT_REASON, by: 'edit' } });
  }
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
