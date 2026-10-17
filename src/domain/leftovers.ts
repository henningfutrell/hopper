// Leftovers (issue #1116, design.md "Leftovers a person decides"): what the layout before issue #1188 left in a work tree's
// `.hopper-scratch` that the sweep does not judge — a dir whose job the hopper does not know, and a repository mirror kept
// there — listed on each machine for a person, who keeps or removes each one. Pure.
import type { ActingPerson } from './failures.ts';
import type { DomainEvent, Job } from './types.ts';

/** One leftover as a machine's listing found it: a dir right in `.hopper-scratch`, or a repository mirror in it. */
export interface Leftover {
  path: string;
  kind: 'scratch' | 'mirror';
  ageMs: number;
  /** It holds work not pushed: a change, or a commit no remote has. */
  unpushed: boolean;
  /** A mirror's: the worktrees that still use it. */
  users?: number;
  /** Its size; absent, not measured. */
  bytes?: number;
}

/** A leftover with a person's decision to keep it, when one stands. */
export interface LeftoverView extends Leftover { kept?: { at: string } & Partial<ActingPerson> }

/** The leftovers on one machine, as the sweep last listed them. */
export interface MachineLeftovers { at: string; items: LeftoverView[] }

export const LEFTOVER_EVENTS = ['machine.leftover_kept', 'machine.leftover_removed'] as const;

/**
 * The leftovers the sweep does not judge, of what a listing found: every mirror, and each scratch dir whose name is no job
 * the hopper knows (another hopper's, a test's, anything else left there). A known job's dir is the sweep's: it reaps an
 * ended one by the reap's rule, and a live one is its job's.
 */
export function unjudged(listed: readonly Leftover[], jobOf: (id: string) => Job | undefined): Leftover[] {
  return listed.filter((l) => l.kind === 'mirror' || jobOf(l.path.slice(l.path.lastIndexOf('/') + 1)) === undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The leftovers with the decisions that stand: a `machine.leftover_kept` of the machine and path, newest first in `events`,
 * that no `machine.leftover_removed` came after.
 */
export function withDecisions(machineId: string, items: readonly Leftover[], events: readonly DomainEvent[]): LeftoverView[] {
  const newest = new Map<string, DomainEvent>();
  for (const e of events) {
    const d = e.data as { machineId?: unknown; path?: unknown };
    if (d.machineId !== machineId || typeof d.path !== 'string' || newest.has(d.path)) continue;
    newest.set(d.path, e);
  }
  return items.map((l) => {
    const e = newest.get(l.path);
    if (e?.type !== 'machine.leftover_kept') return { ...l };
    const { person, via } = e.data as Partial<ActingPerson>;
    return { ...l, kept: { at: e.at, ...(person ? { person } : {}), ...(via ? { via } : {}) } };
  });
}
