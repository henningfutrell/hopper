// Poll backoff (issue #1264, glossary "Poll backoff"): a job source whose timed syncs find nothing changed syncs less
// often — each such sync doubles the interval to the next, up to MAX_BACKOFF_FACTOR times its poll interval. A change (a
// new or changed item, a job made, a job of its own not ended, an error), or a sync a person asked for (Sync now, an intake
// action, a GitHub delivery's sync), brings back its poll interval. GitHub's 304 to a conditional request is no change: the
// rate limiter answers it with the answer it kept, so the source discovers the same items.
import { createHash } from 'node:crypto';
import type { SourceItem } from '../domain/ports.ts';
import type { SourceCallLog } from '../domain/sources.ts';
import type { Slot } from './sync-slots.ts';

/** The most a backoff stretches a poll interval. */
export const MAX_BACKOFF_FACTOR = 8;

/** The interval to the next timed sync after `unchanged` syncs in a row found nothing changed. */
export function backedOffMs(pollMs: number, unchanged: number): number {
  return pollMs * Math.min(2 ** Math.max(0, unchanged), MAX_BACKOFF_FACTOR);
}

/** What a discover answered, as a later answer is compared with it. */
export function answerPrint(items: readonly SourceItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/**
 * After a sync (issue #1264): its pass's calls go to the call log, its status reads its calls from there, and a sync that
 * found nothing changed — `changed` false and its discover answered as the last one did — counts towards the backoff.
 */
export function afterSync(slot: Slot, o: { changed: boolean; calls?: SourceCallLog | undefined; now: string }): void {
  const n = slot.source.passCalls?.();
  if (n) o.calls?.record(slot.source.name, o.now, n);
  if (o.calls) slot.status.calls = o.calls.volume(slot.source.name, o.now);
  const changed = o.changed || slot.answer !== slot.answered;
  slot.answered = slot.answer;
  slot.unchanged = changed ? 0 : (slot.unchanged ?? 0) + 1;
}

/** The interval to the slot's next timed sync, backed off when `backoff`; its status says both. */
export function nextPollMs(slot: Slot, pollMs: number, backoff: boolean): number {
  const next = backoff ? backedOffMs(pollMs, slot.unchanged ?? 0) : pollMs;
  Object.assign(slot.status, { pollMs, nextPollMs: next });
  return next;
}
