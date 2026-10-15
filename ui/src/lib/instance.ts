// Which hopper answers (issue #1295, design.md "Which hopper answers"). A test hopper a job started took the address of
// the user's hopper while that one was down, and the page open on it showed the test hopper's master key banner as the
// real hopper's. Every answer carries its hopper's tag (`x-hopper-instance`), and the event stream opens with it. The
// page keeps the tag of the hopper it talks to — this page's first, else the one this browser kept (`jh_instance`) — and
// an answer with another tag, or with none once the tag is known, is another hopper's: it is dropped, nothing more is
// sent to that address (the session neither sent nor cleared), and HopperGate shows one notice in place of the page.
import { useSyncExternalStore } from 'react';

export const INSTANCE_HEADER = 'x-hopper-instance';
const KEPT = 'jh_instance';

/** The hopper this page talks to, and the one that answered in its place. */
export interface OtherHopperSeen { expected: string; seen: string | null }

export class OtherHopper extends Error {
  readonly at: OtherHopperSeen;
  constructor(at: OtherHopperSeen) {
    super(`another hopper answers at this address (${at.seen ?? 'no tag'}, not ${at.expected})`);
    this.at = at;
  }
}

const kept = (): string | undefined => { try { return localStorage.getItem(KEPT) ?? undefined; } catch { return undefined; } };
const keep = (tag: string): void => { try { localStorage.setItem(KEPT, tag); } catch { /* storage blocked: this page alone knows it */ } };

let mine: string | undefined;
let other: OtherHopperSeen | undefined;
const listeners = new Set<() => void>();

/** Another hopper answered: throws OtherHopper from then on, whatever answers next. */
export function refuseOtherHopper(): void {
  if (other) throw new OtherHopper(other);
}

/** An answer's tag, checked against the page's hopper: throws OtherHopper when it is another's. */
export function checkInstance(seen: string | null): void {
  refuseOtherHopper();
  const expected = knownHopper();
  if (expected === undefined) {
    if (seen) { mine = seen; keep(seen); }
    return;
  }
  if (seen !== expected) {
    other = { expected, seen };
    for (const l of listeners) l();
    throw new OtherHopper(other);
  }
  if (mine === undefined) mine = seen;
}

/** The hopper this page talks to: undefined until an answer named it (a daemon before the tag names none). */
export const knownHopper = (): string | undefined => mine ?? kept();

/** The other hopper that answered, or undefined while every answer is this page's hopper's. */
export const otherHopper = (): OtherHopperSeen | undefined => other;

export function useOtherHopper(): OtherHopperSeen | undefined {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, otherHopper);
}

/** The person says the hopper at this address is theirs now (set up again): the old one is forgotten. */
export function forgetKeptHopper(): void {
  try { localStorage.removeItem(KEPT); } catch { /* storage blocked: nothing kept */ }
}
