// A job that polls hopper state (issue #1210, design.md "Polls of hopper state"): the same read of one pull request or
// issue, asked again and again by one job, is a loop that waits on something the hopper itself does or sees. The proxy
// still answers it, and says so (`poll`): the job uses `pr wait` or HOPPER_WAITING instead. A job on a wait for its own
// command that only polls is told to the engine, which types the wait and ends it after an hour (own-command.ts
// `polledWait`). Kept in memory: a restart starts every count again.
import type { WaitOn } from '../domain/wait-on.ts';
import type { ProxyOp } from './policy.ts';

/** The same read this many times in the window is a poll. */
export const POLL_READS = 3;
export const POLL_WINDOW_MS = 15 * 60 * 1000;

export interface PollWatch {
  /** Counts one read `key` of the job at `at` (ms): how many of the same it asked in the window, this one included. */
  read(jobId: string, key: string, at: number): number;
}

export function createPollWatch(windowMs = POLL_WINDOW_MS): PollWatch {
  const seen = new Map<string, number[]>();
  return {
    read(jobId, key, at) {
      // Drop what left the window, every job's: the map stays as small as the jobs that read now.
      for (const [k, times] of seen) {
        const kept = times.filter((t) => at - t < windowMs);
        if (kept.length > 0) seen.set(k, kept); else seen.delete(k);
      }
      const k = `${jobId}\0${key}`;
      const times = [...(seen.get(k) ?? []), at];
      seen.set(k, times);
      return times.length;
    },
  };
}

/** What a poll of `op` on `number` of `repo` waits on: a pull request's checks, its merge, or an issue. */
export function polledOn(op: ProxyOp, repo: string, number: number): WaitOn {
  if (op.startsWith('issue.')) return { kind: 'item', repo, number };
  return { kind: 'pull_request', repo, number, about: op === 'pr.checks' ? 'checks' : 'merge' };
}

/** What the answer to a poll says: wait through the hopper, once. */
export function pollNote(op: ProxyOp, repo: string, number: number, reads: number): string {
  const wait = op.startsWith('issue.')
    ? `end your turn with HOPPER_WAITING, on: issue ${repo}#${number}: the hopper wakes you when it closes`
    : `run sh "$HOPPER_GH" pr wait ${number} --repo ${repo}${op === 'pr.checks' ? '' : ' --for mergeable'} once, or end your turn with HOPPER_WAITING, on: pr ${number} ${op === 'pr.checks' ? 'checks' : 'merge'}`;
  return `You asked ${op} of ${repo}#${number} ${reads} times in ${POLL_WINDOW_MS / 60_000} minutes. Do not poll the hopper: ${wait}. The hopper tends, rebases and merges pull requests by itself. A wait on your own command that only polls ends after an hour.`;
}
