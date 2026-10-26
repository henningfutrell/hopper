// Pull requests of a waiting job (issue #1143 reopened, design.md "Pull requests of a waiting job"), the sync loop's half:
// in a round of every follow, after the companions, the pull requests the jobs of each item opened through the hopper are
// read (`JobSource.readCompanions`, `merge: false`: only read) while the item's newest job is on its own wait. The first one
// with merge conflicts at a head that has not woken the job ends its wait (`SourceHost.wakeOnConflict`, `job.wait_ended`
// with `conflicting`); the job is told to rebase it and wait again, and the tend note goes on the pull request
// (`JobSource.tendStarted`). What each read saw is kept on the job (`waitingPulls`). Not while the source is paused; a throw
// is logged and asked again at the next round.
import { openedPullRequests } from '../domain/direct-jobs.ts';
import type { JobSource } from '../domain/ports.ts';
import { pullRequestRepo, type Job } from '../domain/types.ts';
import { conflictWake, conflictWakeNote, waitingAfter, waitingPullRequests } from '../domain/waiting-pull-requests.ts';
import type { AfterDoneContext } from './after-done.ts';

/** How many of a job's `github_proxy.done` events are read for the pull requests it opened. */
const OPENED_READ = 1000;

export function waitingJobPullRequests(c: Pick<AfterDoneContext, 'store' | 'host' | 'enqueue' | 'setSource'>) {
  const { store } = c;
  const opened = (jobId: string) => openedPullRequests(store.events.recent(OPENED_READ, ['github_proxy.done'], jobId));

  /** Read the pull requests of the waiting jobs of the source's `listed`, and wake each one that has one with merge conflicts. */
  return async function read(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.readCompanions || source.paused?.() !== undefined) return;
    const held = waitingPullRequests(listed.map((j) => store.jobs.get(j.id) ?? j), opened);
    if (held.length === 0) return;
    try {
      const pulls = held.flatMap((h) => h.pulls.map((url) => ({ repo: pullRequestRepo(url, h.job.source!.repo!), number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), job: h.job, merge: false as const })));
      const answers = await source.readCompanions(pulls);
      await Promise.all(held.map((h) => c.enqueue(h.job.id, async () => {
        const job = store.jobs.get(h.job.id);
        if (!job) return;
        const due = conflictWake(job, h.pulls, answers);
        const woken = due !== undefined && job.wait !== undefined && c.host.wakeOnConflict(job.id, job.wait.since, due.url, conflictWakeNote(job.wait, due.url, due.base));
        const now = store.jobs.get(job.id) ?? job;
        const after = waitingAfter(now, h.pulls, answers, woken ? due.url : undefined);
        const before = (now.sourceState?.source as { waitingPulls?: unknown } | undefined)?.waitingPulls ?? {};
        if (JSON.stringify(after) !== JSON.stringify(before)) c.setSource(job.id, { ...(now.sourceState?.source ?? {}), waitingPulls: after });
        if (woken) await source.tendStarted?.(job, due.url, 'rebase');
      })));
    } catch (e) {
      console.warn(`hopper: ${source.name}: reading the pull requests of waiting jobs failed, asked again at the next round: ${(e as Error).message}`);
    }
  };
}
