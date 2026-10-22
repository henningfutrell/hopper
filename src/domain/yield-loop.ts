/**
 * Give the event loop back (issue #2392). Every store call blocks it ("Database": the Store port stays synchronous), and
 * an await of a promise that is already settled lets no request in: a timer's pass over hundreds of items held every
 * request, the UI and the machines' links until it ended. A timer's loop over many items awaits this between its items,
 * so a request waits for one item, not for the whole pass. Each item's read-modify-write stays in one synchronous step,
 * and the loop keeps no state across items that another step can change meanwhile (`docs/design.md` "Database").
 */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How long a timer's loop may hold the event loop before it gives it back: below a slow request, above a short pass. */
export const LOOP_BUDGET_MS = 50;

/**
 * A loop's yield that gives the event loop back only once the loop held it `budgetMs` since its start or its last yield.
 * A short pass runs as one step, as before; only a long one lets other steps in between its items.
 */
export function loopYield(budgetMs = LOOP_BUDGET_MS): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < budgetMs) return;
    await yieldToLoop();
    since = performance.now();
  };
}
