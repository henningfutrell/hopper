// The pull requests jobs wait on (issue #1433, design.md "What a wait waits on"), the sync loop's half: at each sync of a
// source, the pull requests its jobs on their own wait name (`waitedPullRequests`) are asked of it
// (`JobSource.endedPullRequests`). Each one merged or closed without a merge is recorded on each job waiting on it
// (`job.waited_pull_request_ended`), and the engine wakes them on that event (`settledBy`). A pull request a job follows
// records its end itself; this one is for the rest — another job's that no follow holds now, a stray a person closed, one
// of no job. Not while the source is removed; a throw is logged and asked again at the next sync.
import type { JobSource, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { waitedPullRequests } from '../domain/wait-on.ts';

export function waitedPullRequestEnds(store: Pick<UserStore, 'jobs' | 'events'>) {
  /** Read the pull requests the waits of `listed`, the source's jobs, name; record each ended one on its waiting jobs. */
  return async function ends(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.endedPullRequests) return;
    const waited = waitedPullRequests(listed.map((j) => store.jobs.get(j.id) ?? j));
    if (waited.length === 0) return;
    try {
      const ended = await source.endedPullRequests(waited.map(({ repo, number }) => ({ repo, number })));
      for (const e of ended) {
        const w = waited.find((x) => x.repo.toLowerCase() === e.repo.toLowerCase() && x.number === e.number);
        for (const jobId of w?.jobIds ?? []) {
          if (store.jobs.get(jobId)?.status !== 'waiting_on') continue;
          store.events.append({ type: 'job.waited_pull_request_ended', jobId, data: { pullRequest: e.pullRequest, state: e.state } });
        }
      }
    } catch (e) {
      console.warn(`hopper: ${source.name}: reading the pull requests jobs wait on failed, asked again at the next sync: ${(e as Error).message}`);
    }
  };
}
