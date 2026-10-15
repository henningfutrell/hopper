// A job's wait on its own command (issue #1037, design.md "A wait on its own command"): a job that ended its turn with
// HOPPER_WAITING while only a command of its own runs in the background (a build, a test run) waits on nothing outside
// the job. Its `until:` names that command; it shows as running, not as waiting on the outside world. Pure.
import type { Job, JobWait } from './types.ts';
import type { WaitOn } from './wait-on.ts';

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

/** How long a wait on its own command that only polls hopper state may last (issue #1210), as a tending hold (`MAX_HELD_MS`). */
export const POLL_WAIT_CAP_MS = 60 * 60 * 1000;

/** What the hopper does with a job whose own command polls `on`: type its wait, end it, or nothing. */
export type PolledWait = { kind: 'type'; wait: JobWait } | { kind: 'end' };

/**
 * A job on a wait for its own command whose command polls hopper state (issue #1210, design.md "Polls of hopper state"): its
 * wait says what it polls (`on`, `polledAt`), once, and stays its own command, so it holds no tending queue. Once it waited
 * `POLL_WAIT_CAP_MS`, the hopper ends it. Undefined for any other job, and for a wait typed so already.
 */
export function polledWait(job: Pick<Job, 'status' | 'wait'>, on: WaitOn, nowMs: number): PolledWait | undefined {
  const w = job.wait;
  if (job.status !== 'waiting_on' || !w?.ownCommand) return undefined;
  if (nowMs - Date.parse(w.since) >= POLL_WAIT_CAP_MS) return { kind: 'end' };
  if (w.polledAt) return undefined;
  return { kind: 'type', wait: { ...w, on, polledAt: new Date(nowMs).toISOString() } };
}
