/**
 * Give the event loop back (issue #2392). Every store call blocks it ("Database": the Store port stays synchronous), and
 * an await of a promise that is already settled lets no request in: a timer's pass over hundreds of items held every
 * request, the UI and the machines' links until it ended. A timer's loop over many items awaits this between its items,
 * so a request waits for one item, not for the whole pass. Each item's read-modify-write stays in one synchronous step,
 * and the loop keeps no state across items that another step can change meanwhile (`docs/design.md` "Database").
 */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
