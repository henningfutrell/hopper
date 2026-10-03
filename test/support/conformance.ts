// Validates every event a test emits against src/events schemas.
//   const c = trackConformance(store);  ...run the scenario...  assertAllConform();
import type { DomainEvent } from '../../src/domain/types.ts';
import { validateEvent } from '../../src/events/index.ts';

export interface ConformanceTracker {
  /** Events that failed validation, with their issues. */
  invalid: { event: DomainEvent; issues: string[] }[];
  seen: number;
  stop(): void;
}

const trackers = new Set<ConformanceTracker>();

export function trackConformance(store: { events: { subscribe(l: (e: DomainEvent) => void): () => void } }): ConformanceTracker {
  const tracker: ConformanceTracker = { invalid: [], seen: 0, stop: () => { off(); trackers.delete(tracker); } };
  const off = store.events.subscribe((event) => {
    tracker.seen++;
    const r = validateEvent(event);
    if (!r.ok) tracker.invalid.push({ event, issues: r.issues });
  });
  trackers.add(tracker);
  return tracker;
}

/** Throws listing every nonconforming event; checks `tracker`, or all live trackers when omitted. */
export function assertAllConform(tracker?: ConformanceTracker): void {
  const bad = (tracker ? [tracker] : [...trackers]).flatMap((t) => t.invalid);
  if (!bad.length) return;
  throw new Error(`${bad.length} event(s) violate their schema:\n${bad
    .map((b) => `  #${b.event.seq} ${b.event.type}: ${b.issues.join('; ')}`).join('\n')}`);
}
