// Drift in the resource ledger (issue #2715, design.md "Component watchers"): an ended job whose cleanup still failed once
// the grace period after its end passed is a hopper bug, never a person's todo. One drift per cause the reap named
// (`LEFT_CAUSE_TEXT`), each job one item by its id: no path, no machine. An entry on a machine that is offline, or that no
// executor reaches, is no drift: the machine's state is, and its next pass reaps. Pure: no I/O, no clock.
import type { Drift, DriftItem } from './drift.ts';
import type { LeftCause } from './machine-shell.ts';
import { LEFT_CAUSE_TEXT, type CleanupLeftover } from './resource-ledger.ts';

export const CLEANUP_LEDGER = 'cleanup-jobs';

/** The kind of drift a failed entry's reason makes; undefined: the machine's state, no drift. */
function kindOf(reason: string): string | undefined {
  if (/^its machine .* is offline$|^no executor reaches its machine /.test(reason)) return undefined;
  if (/^the reap on .* failed: /.test(reason)) return 'cleanup_reap_failed';
  const cause = (Object.keys(LEFT_CAUSE_TEXT) as LeftCause[]).find((c) => reason.endsWith(` is still there: ${LEFT_CAUSE_TEXT[c]}`));
  return cause ? `cleanup_${cause}` : 'cleanup_cause_unknown';
}

/** The drift in `leftovers` (`cleanupLeftoversOf`): each job's failed entries by the kind their reason makes, in the order found. */
export function cleanupDrift(leftovers: readonly CleanupLeftover[]): Drift[] {
  const byKind = new Map<string, DriftItem[]>();
  for (const l of leftovers) {
    const counts = new Map<string, number>();
    for (const e of l.entries) {
      const kind = e.state === 'failed' && e.reason ? kindOf(e.reason) : undefined;
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const [kind, n] of counts) byKind.set(kind, [...byKind.get(kind) ?? [], { key: l.jobId, says: `${n} thing${n === 1 ? '' : 's'} not removed`, truth: 'job ended', since: l.endedAt }]);
  }
  return [...byKind].map(([kind, items]) => ({ watcher: CLEANUP_LEDGER, kind, items }));
}
