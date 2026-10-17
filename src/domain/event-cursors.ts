// Event cursors (issue #1572, design.md "Event cursors"): the port a consumer of the event log follows it through.
import type { DomainEvent } from './types.ts';

/**
 * Where each consumer of the event log stands (issue #1572, design.md "Event cursors"): the last event it handled, kept in
 * the database, so an event committed just before a stop is handed to it at the next start.
 */
export interface EventCursorRepository {
  /**
   * Hand `handle` each event after `consumer`'s cursor, oldest first: at once those committed while it did not follow,
   * then each new one after its commit. A consumer with no cursor yet starts after the newest event.
   */
  follow(consumer: string, handle: (event: DomainEvent) => void): EventFollower;
}

export interface EventFollower {
  /**
   * Move the cursor to `seq` (default: the last event handed); never back. Call it in the transaction that keeps what the
   * handling made, so the two are kept together or not at all.
   */
  save(seq?: number): void;
  /** Hand no more events. The cursor stays where the last save put it. */
  stop(): void;
}
