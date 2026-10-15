// What a follow found, kept (issue #1076, design.md "Change kinds"), split from after-done.ts for its line budget: the
// source state, then the events it makes — a change kind that is new or changed, and a move to the landing branch (issue
// #1143). And the kind the follow last classified a job's pull request as.
import type { UserStore } from '../domain/store.ts';
import type { FollowUp, Job, PullRequestSeen } from '../domain/types.ts';

/** The change kind of the job's followed pull request, as its follow last classified it. */
export const changeOf = (job: Job | undefined) => (job?.sourceState?.source as { seen?: PullRequestSeen } | undefined)?.seen?.change;

/**
 * Keep what follow-up `r` of job `jobId` found, then record `job.pull_request_classified` when its change kind is new or
 * changed, and `job.pull_request_retargeted` when the follow moved it.
 */
export function keepFollowed(c: { store: Pick<UserStore, 'jobs' | 'events'>; setSource(jobId: string, source: Record<string, unknown>): void }, jobId: string, r: FollowUp): void {
  const was = changeOf(c.store.jobs.get(jobId));
  const now = (r.state as { seen?: PullRequestSeen }).seen?.change;
  c.setSource(jobId, r.state);
  if (now && (now.kind !== was?.kind || JSON.stringify(now.why) !== JSON.stringify(was.why))) {
    c.store.events.append({ type: 'job.pull_request_classified', jobId, data: { pullRequest: r.pullRequest, kind: now.kind, why: now.why } });
  }
  if (r.retargeted) c.store.events.append({ type: 'job.pull_request_retargeted', jobId, data: { pullRequest: r.pullRequest, ...r.retargeted } });
}
