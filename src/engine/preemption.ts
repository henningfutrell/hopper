// Preemption (issue #1525, design.md "Preemption"): the Decision marks a running job `preempted` and names it; here the
// runner parks it on the Park button's path (its lane frees in the transaction that parks it, its pane and agent end,
// its work tree, agent session and checkpoint are kept), and once parked it is queued again at once, pinned to its
// machine with PARKED_RESUME pending, so its claim resumes its agent session where it stopped. A job the runner does not
// hold (it ended meanwhile) loses its mark, so nothing waits on a park that never comes.
import { DEFAULT_PREEMPTION, type PreemptionSettings } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';
import type { EngineContext } from './context.ts';
import { recordUnpark } from './park.ts';
import type { Runner } from './runner.ts';

export const preemptionSettings = (store: Pick<UserStore, 'settings'>): PreemptionSettings => store.settings.getPreemption() ?? DEFAULT_PREEMPTION;

/** After the commit: park the job the Decision preempted. */
export function preemptRunning(c: EngineContext, runner: Pick<Runner, 'park'>, jobId: string): void {
  if (runner.park(jobId)) return;
  c.store.tx(() => {
    const job = c.store.jobs.get(jobId);
    if (job?.preempted && job.status !== 'parked') c.store.jobs.update(jobId, { preempted: undefined });
  });
}

/** Once a preempted job is parked: back in the queue, to resume its agent session on its machine. */
export function requeuePreempted(c: EngineContext, jobId: string): void {
  c.store.tx(() => {
    const job = c.store.jobs.get(jobId);
    if (job?.status === 'parked' && job.preempted) recordUnpark(c, jobId);
  });
}
