// After done (issue #579), the sync loop's half, at each sync of a source, on each job's report chain. A finished job
// whose pull request its report kept to follow is asked of its source (`JobSource.follow`): merged or closed without a
// merge is recorded (`job.pull_request_merged`, `job.pull_request_closed`) with the source state it leaves. And a job
// that failed only for want of a merged pull request — `not complete:`, from before a pull request was done — and still
// waits on a person is judged again: done or partly done now, it is finished (its hand-off closes on `job.finished`) and
// its end reported again, so its issue loses `hopper:failed`. A throw is kept as a retry and asked again next sync.
import type { JobSource, SourceHost, UserStore } from '../domain/ports.ts';
import { following, judge, type Job } from '../domain/types.ts';

export interface AfterDoneContext {
  store: Pick<UserStore, 'jobs' | 'events' | 'handoffs'>;
  host: Pick<SourceHost, 'finishComplete'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Whether the job's end is reported to its source. */
  finalReported(job: Job): boolean;
  /** Keep the job's new source state. */
  setSource(jobId: string, source: Record<string, unknown>): void;
  /** Report the job's end again: a finish replaced its reported failure. */
  reportAgain(jobId: string): void;
  /** Asking the source failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
}

const NOT_COMPLETE = /^not complete: /;

export function createAfterDone(c: AfterDoneContext) {
  const { store } = c;

  async function follow(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    if (!job || !following(job)) return;
    const r = await source.follow!(job);
    if (!r) return;
    c.setSource(jobId, r.state);
    store.events.append({ type: r.outcome === 'merged' ? 'job.pull_request_merged' : 'job.pull_request_closed', jobId, data: { pullRequest: r.pullRequest, part: r.part } });
  }

  async function judgeAgain(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    if (job?.status !== 'failed') return;
    const v = await judge(source, job);
    if (!v.done && !('partlyDone' in v)) return;
    if (c.host.finishComplete(jobId, 'partlyDone' in v ? v.partlyDone : undefined)) c.reportAgain(jobId);
  }

  const waitsOnPerson = (j: Job) => j.status === 'failed' && NOT_COMPLETE.test(j.error ?? '') && store.handoffs.forJob(j.id)?.status === 'open';

  return {
    /** One sync of the source: every job of its to follow, or to judge again. */
    async catchUp(source: JobSource, jobs: Job[]): Promise<void> {
      const run = (j: Job, fn: (s: JobSource, id: string) => Promise<void>) =>
        c.enqueue(j.id, () => fn(source, j.id).catch((e: unknown) => { c.failed(j.id, e); }));
      await Promise.all(jobs.filter((j) => c.finalReported(j)).flatMap((j) =>
        (j.status === 'finished' && source.follow && following(j) ? [run(j, follow)] : waitsOnPerson(j) ? [run(j, judgeAgain)] : [])));
    },
  };
}
