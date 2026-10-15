// The sync loop's slots (sync.ts): one per job source, keyed by its instance name. The sources follow
// the plugins config live (issue #356, `followSources`): a new one gets a slot; a changed one (same name,
// new instance) takes the slot over, counts and jobs kept; a removed one keeps its slot, marked removed,
// until the sync loop finds nothing of its own left to report.
import type { Clock, JobSource, UserStore } from '../domain/ports.ts';
import type { SourceStatus } from '../domain/types.ts';
import type { SyncAsk } from './after-answer-timings.ts';

/** Why a removed source pulls nothing more (issue #356): it only finishes its own jobs. */
export const REMOVED = 'removed from the plugins config';

export interface NotRerun { key: string; job: string; status: string; reason: string }

export interface Slot {
  source: JobSource;
  status: SourceStatus;
  chain: Promise<void>;
  /** The sync queued on the chain that has not started yet (issue #1019): a sync asked for meanwhile joins it. */
  queued?: { asked: boolean; done: Promise<void>; asks: SyncAsk[] };
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
  /** A pull request of its jobs merged or closed while it synced (issue #967): the next sync runs at once. */
  again?: boolean;
  /** A pull request of its jobs merged or closed (issue #985): its next sync follows every one. */
  followAll?: boolean;
  /** When its last round of follows started, and its last round of every one (issue #985), ms since the epoch. */
  followedAt?: number;
  followedAllAt?: number;
  /** A GitHub delivery named one of its job repositories (issue #1079): the sync it starts soon after. */
  delivered?: NodeJS.Timeout;
  /** The setup problem last logged (issue #1243), so each is said once, and once when it clears. */
  setupSaid?: string;
  /** The pause last logged (issue #1351), so each is said once, and once when it ends. */
  pauseSaid?: string;
  /** Poll backoff (issue #1264): the syncs in a row that found nothing changed; what its discover answered now, and in the sync before. */
  unchanged?: number;
  answer?: string;
  answered?: string;
  /** The outbox send an intake action asked for (issue #1238), once its batch window ends. */
  outboxSoon?: NodeJS.Timeout;
}

/**
 * A sync asked for while one waits to start joins it (issue #1019): what it is answered, or undefined when none waits.
 * Its asks are timed with that sync (issue #1194).
 */
export function joined(slot: Slot, asked: boolean, asks: readonly SyncAsk[]): Promise<void> | undefined {
  if (!slot.queued) return undefined;
  slot.queued.asked ||= asked;
  slot.queued.asks.push(...asks);
  return slot.queued.done;
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

/**
 * After a sync: log a changed error, or the end of one (issue #358); record source.stalled once a run of failures
 * passes the threshold.
 */
export function told(slot: Slot, previous: string | undefined, o: { clock: Clock; stallAfterMs: number; events: Pick<UserStore['events'], 'append'> }): void {
  const st = slot.status;
  const name = slot.source.name;
  if (st.state !== 'error') {
    if (slot.failing) console.warn(`hopper: source ${name} is ok again`);
    delete slot.failing;
    return;
  }
  if (st.lastError !== previous) console.warn(`hopper: source ${name} failed: ${st.lastError}`);
  slot.failing ??= { since: o.clock.now().toISOString(), stalled: false };
  if (slot.failing.stalled || o.clock.now().getTime() - Date.parse(slot.failing.since) < o.stallAfterMs) return;
  slot.failing.stalled = true;
  o.events.append({ type: 'source.stalled', data: { source: name, kind: slot.source.kind, error: st.lastError ?? '', since: slot.failing.since } });
}

/**
 * A source's status detail after a sync: its own facts; every item it listed, taken (with its job, read when the status
 * is: `live`) or not (with its reason) — issue #440 —, none while paused; and its report troubles.
 */
export function detailOf(slot: Slot, paused: string | undefined, permanentErrors: number): Record<string, unknown> {
  const intake = paused === undefined ? slot.source.intake?.() : undefined;
  return {
    ...slot.source.describe(),
    ...(intake ? { intake } : {}),
    ...(paused !== undefined ? { paused } : {}),
    permanentErrors,
    reportRetries: slot.retrying.size,
    ...(slot.notRerun.length ? { notRerun: slot.notRerun } : {}),
  };
}
