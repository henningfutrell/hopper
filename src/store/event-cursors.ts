// Event cursors (issue #1572, tenant migration 75): where each consumer of the event log stands — the last event it
// handled, by seq. A consumer follows the log from its cursor, so an event committed just before a stop, which no
// listener saw, is handed to it at the next start.
import type { EventCursorRepository, EventLog } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

export const EVENT_CURSOR_TABLE = 'CREATE TABLE event_cursors (consumer TEXT PRIMARY KEY, seq BIGINT NOT NULL)';

/** Events read per catch-up query. */
const CATCH_UP_BATCH = 500;

export function createEventCursorRepository(c: StoreContext, events: Pick<EventLog, 'since' | 'subscribe'>): EventCursorRepository {
  const kept = (consumer: string): number | undefined => {
    const r = c.db.get('SELECT seq FROM event_cursors WHERE consumer = ?', consumer);
    return r ? Number(r.seq) : undefined;
  };
  const keep = (consumer: string, seq: number): void => {
    c.db.run(`INSERT INTO event_cursors (consumer, seq) VALUES (?, ?)
      ON CONFLICT (consumer) DO UPDATE SET seq = GREATEST(event_cursors.seq, excluded.seq)`, consumer, seq);
  };
  return {
    follow(consumer, handle) {
      let saved = kept(consumer);
      if (saved === undefined) {
        // A first start: from the newest event on, so a new consumer does not replay the history.
        saved = Number(c.db.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')!.seq);
        keep(consumer, saved);
      }
      let last = saved;
      const hand = (e: DomainEvent): void => {
        if (e.seq <= last) return;
        last = e.seq;
        try { handle(e); } catch (err) { console.error(`event consumer ${consumer} failed`, err); }
      };
      // Catch up first, then listen: an event a handler appends during the catch-up is read by the next query.
      for (let batch = events.since(last, CATCH_UP_BATCH); batch.length > 0; batch = events.since(last, CATCH_UP_BATCH)) {
        for (const e of batch) hand(e);
      }
      const unsubscribe = events.subscribe(hand);
      return {
        save(seq = last) {
          if (seq <= saved!) return;
          keep(consumer, seq);
          saved = seq;
        },
        stop: unsubscribe,
      };
    },
  };
}
