// A heap abort pattern (issue #2722, design.md "Heap abort patterns"): the same command ran out of heap (`job.heap_aborted`)
// in several jobs within a day. Running a failed job of it again does not help — the command needs a fix, or more heap —,
// so the failure assessor holds that job on a problem of the command, for a person, instead of a retry. Pure.
import type { DomainEvent } from '../domain/types.ts';

/** The cause of a problem of a heap abort pattern: never matched by text, so not in `BUILTIN_CAUSES`. */
export const HEAP_ABORT_CAUSE = 'heap-abort';

/** How far back the heap aborts of a pattern count. */
export const HEAP_PATTERN_WINDOW_MS = 86_400_000;

const PREFIX = 'heap-abort:';

/** One heap abort of a job, as `job.heap_aborted` recorded it. */
export interface HeapAbortSeen { jobId: string; command: string; at: string }

/** A command that ran out of heap in `jobs` jobs: its problem's signature and title, and why the job is held. */
export interface HeapPattern { command: string; jobs: number; signature: string; title: string; reason: string }

/** The heap aborts in `events` (`job.heap_aborted`, any order). */
export const heapAbortsSeen = (events: readonly DomainEvent[]): HeapAbortSeen[] =>
  events.flatMap((e) => {
    const command = (e.data as { command?: unknown }).command;
    return e.type === 'job.heap_aborted' && e.jobId && typeof command === 'string' && command ? [{ jobId: e.jobId, command, at: e.at }] : [];
  });

export const heapSignature = (command: string): string => `${PREFIX}${command}`;

/**
 * The pattern the job's own heap aborts are part of: a command it ran out of heap with that `threshold` jobs or more ran out
 * of heap with (this job counted), at or after `since` and after the newest problem of the command a person or a check
 * resolved (`resolvedAt` by signature) — a fix since then starts the count again. The command of the most jobs when it has
 * more; undefined when none is a pattern.
 */
export function heapPatternOf(seen: readonly HeapAbortSeen[], jobId: string, threshold: number, since: string, resolvedAt: Readonly<Record<string, string>> = {}): HeapPattern | undefined {
  const own = new Set(seen.filter((s) => s.jobId === jobId).map((s) => s.command));
  let best: HeapPattern | undefined;
  for (const command of own) {
    const signature = heapSignature(command);
    const from = [since, resolvedAt[signature]].filter((t): t is string => t !== undefined).reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    const jobs = new Set(seen.filter((s) => s.command === command && (s.jobId === jobId || Date.parse(s.at) >= Date.parse(from))).map((s) => s.jobId)).size;
    if (jobs < threshold || (best && best.jobs >= jobs)) continue;
    best = {
      command, jobs, signature, title: `Heap abort: ${command}`,
      reason: `${command} ran out of heap in ${jobs} jobs within a day: running it again does not help, it waits for a fix or more heap`,
    };
  }
  return best;
}
