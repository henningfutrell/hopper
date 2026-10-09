// A job's pull request after done (issue #579, design.md "Done is a pull request"). Whether a job that ended done is
// done, partly done or not (`judge`): done — its source finds its work complete; partly done — not complete, but its
// own pull request ships part of its item ("Part of #N"); else not, with why. And what a source tells the sync loop
// when it follows an ended job's pull request: merged, or closed without a merge. Pure but for the source it asks.
import type { Job } from './types.ts';

/** Why a done job is not done, from its source; undefined when it is. A throw: the source could not tell. */
type NotComplete = (job: Job) => Promise<string | undefined>;

export interface FollowsPullRequests {
  /**
   * The URL of the job's own pull request that ships part of its item, open and ready for review or merged; undefined:
   * none. Asked when a done job is not complete: a part ends the run partly done, not failed. Absent: no parts.
   */
  partlyDone?(job: Job): Promise<string | undefined>;
  /**
   * Follow an ended job's pull request, as its source state after its report names it: undefined while it waits; merged
   * or closed without a merge, with the source state to keep. A throw is asked again on a later sync. Absent: nothing followed.
   */
  follow?(job: Job): Promise<FollowUp | undefined>;
}

export interface FollowUp {
  outcome: 'merged' | 'closed';
  pullRequest: string;
  /** The pull request shipped part of the item: merged, the next part may be taken. */
  part: boolean;
  /** The job's source state from now on. */
  state: Record<string, unknown>;
}

/** Done, partly done (the part's pull request), or not, with why. */
export type Verdict = { done: true } | { done: false; partlyDone: string } | { done: false; why: string };

/** The verdict on a done job, from its source: a source that judges nothing takes every done job as done. */
export async function judge(source: { notComplete?: NotComplete; partlyDone?: FollowsPullRequests['partlyDone'] } | undefined, job: Job): Promise<Verdict> {
  const why = await source?.notComplete?.(job);
  if (why === undefined) return { done: true };
  const part = await source?.partlyDone?.(job);
  return part === undefined ? { done: false, why } : { done: false, partlyDone: part };
}

/** A source state that names an ended job's pull request still to follow (issue #579). */
export const following = (job: Job): boolean => (job.sourceState?.source as { follow?: unknown } | undefined)?.follow === 'open';
