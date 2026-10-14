// A job's wait on its own command (issue #1037, design.md "A wait on its own command"): a job that ended its turn with
// HOPPER_WAITING while only a command of its own runs in the background (a build, a test run) waits on nothing outside
// the job. Its `until:` names that command; it shows as running, not as waiting on the outside world. Pure.
import type { Job, JobWait } from './types.ts';

/** `until:` names the job's own background command and its end: "background command b7x2 ends", "own command 4 exits". A poll is the outside world. */
const OWN_COMMAND = /\b(?:own|background)\s+(?:command|shell|task|process)\b.*\b(?:ends|exits|finishes|completes|stops)\b/i;

/** True when the wait's `until:` names the job's own background command. */
export const namesOwnCommand = (w: Pick<JobWait, 'until'>): boolean => w.until !== undefined && OWN_COMMAND.test(w.until);

/** A job's wait on its own command: `command` while it runs, `stuck` once flagged stuck. Undefined for any other job. */
export type OwnWait = 'command' | 'stuck';

export function ownWaitOf(job: Pick<Job, 'status' | 'wait'>): OwnWait | undefined {
  if (job.status !== 'waiting_on' || !job.wait?.ownCommand) return undefined;
  return job.wait.stuckAt ? 'stuck' : 'command';
}
