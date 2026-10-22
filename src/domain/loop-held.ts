/**
 * How long the hopper's own event loop was held since a moment (issue #2427), one reading per process: the event loop
 * watchdog (src/http/event-loop.ts `heldSince`) gives it while it runs. A machine's check that the hopper answers
 * (a probe's address check, a job start's reach check) waits on this loop too: a check that fails while the loop is held
 * is no proof that the machine cannot reach the hopper. A check that overlapped a hold this long is checked again.
 */
export const LOOP_HELD_DOUBT_MS = 2000;

type HeldSince = (from: number) => number;

let reading: HeldSince | undefined;

/** The watchdog's reading from now on; the function returned stops it (only while it is still the one given). */
export function giveLoopHeld(heldSince: HeldSince): () => void {
  reading = heldSince;
  return () => { if (reading === heldSince) reading = undefined; };
}

/** How long the loop was held since `from` (ms since the epoch); 0 with no watchdog. */
export const loopHeldSince = (from: number): number => reading?.(from) ?? 0;

/** Whether the loop was held since `from` long enough that a check that failed meanwhile is checked again. */
export const loopHeldDoubts = (from: number): boolean => loopHeldSince(from) >= LOOP_HELD_DOUBT_MS;
