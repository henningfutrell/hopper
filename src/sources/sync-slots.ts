// The sync loop's slots (sync.ts): one per job source, keyed by its instance name. The sources follow
// the plugins config live (issue #356, `followSources`): a new one gets a slot; a changed one (same name,
// new instance) takes the slot over, counts and jobs kept; a removed one keeps its slot, marked removed,
// until the sync loop finds nothing of its own left to report.
import type { JobSource } from '../domain/ports.ts';
import type { SourceStatus } from '../domain/types.ts';

/** Why a removed source pulls nothing more (issue #356): it only finishes its own jobs. */
export const REMOVED = 'removed from the plugins config';

export interface NotRerun { key: string; job: string; status: string; reason: string }

export interface Slot {
  source: JobSource;
  status: SourceStatus;
  chain: Promise<void>;
  timer?: NodeJS.Timeout;
  /** Last transient report error per job, shown as detail.reportRetries. */
  retrying: Map<string, string>;
  /** Offered items whose newest job ended but cannot run again yet, shown as detail.notRerun. */
  notRerun: NotRerun[];
  /** Keys already logged as not run again, so each is logged once. */
  loggedNotRerun: Set<string>;
  /** Since when the source has been in error (this run of failures), and whether source.stalled was recorded for it. */
  failing?: { since: string; stalled: boolean };
  /** Removed from the plugins config (issue #356): pulls nothing, goes once its jobs ended and are reported. */
  removed?: boolean;
}

export function newSlot(source: JobSource): Slot {
  return {
    source, chain: Promise.resolve(), retrying: new Map(), notRerun: [], loggedNotRerun: new Set(),
    status: { name: source.name, kind: source.kind, state: 'starting', itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: source.describe() },
  };
}

/** Make `slots` follow `sources`; answers the slots to sync now: the new, the changed, the added back and the just removed. */
export function followSources(slots: Map<string, Slot>, sources: JobSource[]): Slot[] {
  const now = new Set(sources.map((s) => s.name));
  const touched: Slot[] = [];
  for (const source of sources) {
    const slot = slots.get(source.name);
    if (!slot) {
      const added = newSlot(source);
      slots.set(source.name, added);
      touched.push(added);
      continue;
    }
    if (slot.source !== source || slot.removed) touched.push(slot);
    slot.source = source;
    slot.status.kind = source.kind;
    delete slot.removed;
  }
  for (const slot of slots.values()) {
    if (now.has(slot.source.name) || slot.removed) continue;
    slot.removed = true;
    touched.push(slot);
  }
  return touched;
}
