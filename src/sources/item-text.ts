// What the sync loop gives the host for an item's snapshot (issue #662): the source's renderer, and — when the item's
// text changed since its snapshot — who edited it since, from the source's timeline. A timeline that cannot be read
// leaves the edits empty: the change still holds the job.
import type { JobSource, SourceHost, SourceItem, SourceRef } from '../domain/ports.ts';
import { isRerunnable, type Job, type JobId } from '../domain/types.ts';

/** The source as the host takes it. */
export function sourceRef(source: JobSource): SourceRef {
  return { name: source.name, kind: source.kind, ...(source.withText ? { withText: source.withText.bind(source) } : {}) };
}

/** The item with who edited it since its snapshot, when its text changed and nothing deals with that yet (`changedSince`). */
export async function withEdits(host: SourceHost, source: JobSource, item: SourceItem, jobId?: JobId): Promise<SourceItem> {
  if (!item.text || !source.editsSince) return item;
  const since = host.changedSince(item, jobId);
  if (since === undefined) return item;
  try {
    return { ...item, text: { ...item.text, edits: await source.editsSince(item, since) } };
  } catch (e) {
    console.warn(`hopper: who edited ${item.key} could not be read: ${(e as Error).message}`);
    return item;
  }
}

/**
 * A discovered item offered to the host: its job not ended follows it (`refresh`: its priority, its spec, a text change
 * holds it), else it becomes a new job (`ingest`). True when a job was made.
 */
export async function offer(host: SourceHost, source: JobSource, offered: SourceItem, existing: Job | undefined): Promise<boolean> {
  const live = existing && !isRerunnable(existing) ? existing : undefined;
  const item = await withEdits(host, source, offered, live?.id);
  if (live) {
    host.refresh(live.id, item, sourceRef(source));
    return false;
  }
  return host.ingest(item, sourceRef(source)) !== null;
}
