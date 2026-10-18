// When each source's GitHub outbox sends (issue #1238, design.md "GitHub outbox"), the sync loop's half: an intake action's
// rows once its batch window ends — the clicks of a burst in one batch —, and every `OUTBOX_EVERY_MS` the rows due, from
// the start on, so the rows a stopped hopper left are sent after its start. Never awaited: each repository a send wrote to
// is made due, and the source syncs then, a timed sync; after an intake action it syncs in any case, so what the action
// changed here is listed. A sync never waits for the outbox. A person's Merge now or Close PR (part 3) must be seen now:
// its source sends at once (`now`), with no batch window, through the sync loop's own act (`acts`).
// Each send is a span linked to the actions that asked for it (issue #1486 part 5, `traceOutboxFlush`).
import type { OutboxActs } from '../domain/github-outbox.ts';
import { causeNow, traceOutboxFlush, type Cause } from '../telemetry/sources.ts';
import type { Slot } from './sync-slots.ts';

/** How long after an intake action its source's GitHub outbox is sent: the actions of a burst go in one batch. */
export const OUTBOX_BATCH_MS = 500;

/** How often each source's GitHub outbox sends the rows due: a row a failed attempt left waits its backoff. */
export const OUTBOX_EVERY_MS = 5_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface OutboxFlushContext {
  slots(): Iterable<Slot>;
  running(): boolean;
  /** A timed sync of the source; `at`: when the act that asked for it asked (`performance.now()`), so its wait counts from then. */
  sync(slot: Slot, at?: number): void;
  /** The source's status read again and sent on the stream: its items' outbox markers as they are now. */
  refresh(slot: Slot): void;
  /** What sends a Merge now or Close PR row, and says one failed for good: the sync loop's. */
  acts(): OutboxActs | undefined;
  batchMs?: number;
}

export function outboxFlushes(c: OutboxFlushContext) {
  let every: NodeJS.Timeout | undefined;

  function flush(slot: Slot, sync: boolean, at?: number, causes: readonly Cause[] = []): void {
    const send = slot.source.flushOutbox;
    if (!send || slot.removed) return;
    void traceOutboxFlush(slot.source.name, causes, () => send(c.acts())).then(({ due, wrote }) => {
      if (!c.running() || slot.removed) return;
      if (due > 0) c.refresh(slot);
      for (const repo of wrote) slot.source.repoChanged?.(repo);
      if (sync || wrote.length > 0) c.sync(slot, at);
    }, (e: unknown) => console.warn(`hopper: the GitHub outbox of ${slot.source.name} could not send: ${message(e)}`));
  }

  const all = () => { for (const slot of c.slots()) flush(slot, false); };

  return {
    /** After an intake action: its items show their rows at once, and the outbox sends once the batch window ends. */
    soon(slot: Slot): void {
      c.refresh(slot);
      const at = performance.now(), cause = causeNow();
      if (cause) (slot.outboxCauses ??= []).push(cause);
      slot.outboxSoon ??= setTimeout(() => {
        const causes = slot.outboxCauses ?? [];
        delete slot.outboxSoon; delete slot.outboxCauses;
        if (c.running()) flush(slot, true, at, causes);
      }, c.batchMs ?? OUTBOX_BATCH_MS);
    },
    /** After a Merge now or Close PR: the item shows its row, and the outbox sends at once. */
    now(slot: Slot): void {
      c.refresh(slot);
      const cause = causeNow();
      flush(slot, false, undefined, cause ? [cause] : []);
    },
    start(): void { every = setInterval(all, OUTBOX_EVERY_MS); all(); },
    stop(): void {
      clearInterval(every);
      for (const slot of c.slots()) { clearTimeout(slot.outboxSoon); delete slot.outboxSoon; delete slot.outboxCauses; slot.source.releaseOutbox?.(); }
    },
  };
}
