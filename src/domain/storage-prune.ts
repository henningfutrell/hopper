// The storage prune (issue #2494, design.md "Hopper's own disk use" → "Part 8"), pure: which exited containers of a
// machine's container runtimes the prune removes, and what it says it removed. The prune itself is src/client/prune.ts.

/** Label keys whose container the prune never removes: the stack's, a kind node's, a job's (its reap removes it). */
export const PRUNE_KEEP_LABELS = ['com.docker.compose.project', 'io.podman.compose.project', 'io.x-k8s.kind.cluster', 'hopper.job'] as const;
/** And any label key with this prefix: the hopper's own boxes, need and check boxes, which their own sweeps remove. */
export const PRUNE_KEEP_PREFIX = 'io.hopper.';

/** One exited container the survey found (issue #2494): its runtime, full id, when it stopped as the runtime said, its label keys. */
export interface ExitedContainer { runtime: 'docker' | 'podman'; id: string; finishedAt: string; labels: string[] }

/** One thing a prune removed, with its size when the runtime said it. */
export interface PrunedItem { runtime: 'docker' | 'podman'; kind: 'container' | 'volume' | 'image'; id: string; bytes?: number }
/** What a finished prune said it removed. */
export interface Pruned { removed: PrunedItem[] }

/**
 * When a container stopped, as epoch ms: docker's RFC 3339 time, or podman's Go time (`2026-10-01 00:20:00.1 -0500 CDT`).
 * Undefined for a zero time (Go's year 1: it never stopped) or a time it cannot read.
 */
export function stoppedAtMs(text: string): number | undefined {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?\s*(Z|[+-]\d\d:?\d\d)?/.exec(text.trim());
  if (!m || m[1]!.startsWith('0001')) return undefined;
  const zone = !m[4] || m[4] === 'Z' ? 'Z' : `${m[4].slice(0, 3)}:${m[4].slice(-2)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? '').slice(0, 4)}${zone}`);
  return Number.isFinite(ms) ? ms : undefined;
}

const kept = (labels: readonly string[]): boolean =>
  labels.some((l) => l.startsWith(PRUNE_KEEP_PREFIX) || (PRUNE_KEEP_LABELS as readonly string[]).includes(l));

/** The exited containers stopped more than `days` ago that carry no label the prune keeps. */
export function containersToPrune(exited: readonly ExitedContainer[], days: number, nowMs: number): ExitedContainer[] {
  return exited.filter((c) => {
    const at = stoppedAtMs(c.finishedAt);
    return at !== undefined && nowMs - at > days * 86_400_000 && !kept(c.labels);
  });
}
